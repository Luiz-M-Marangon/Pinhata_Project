/* =============================================================================
 * Interface da ferramenta Text-to-SQL — Firebird 2.5 + SQLCoder via Ollama
 * -----------------------------------------------------------------------------
 * Como a tela funciona:
 *   Tela 1 (Conexão e contexto): conecta ao Firebird e segue três etapas:
 *     seleciona e classifica (privacidade) as tabelas/colunas, o modelo
 *     (SQLCoder por padrão) interpreta o significado de cada uma e a pessoa
 *     confirma ou corrige. Essas descrições entram no prompt das perguntas —
 *     quanto melhor o contexto, melhor o SQL.
 *   Tela 2 (Perguntar): escreve a pergunta, gera o SQL (streaming do Ollama),
 *     valida no banco sem executar e, só depois da confirmação em um diálogo,
 *     executa e mostra os resultados limitados. Depois da execução, a pessoa
 *     marca se a resposta do modelo está semanticamente correta.
 *   Tela 3 (Avaliação dos modelos): perguntas feitas a cada modelo (7B/15B) com
 *     sintaxe, semântica e erros, para a avaliação do TCC.
 *
 * O que fica no navegador (localStorage): conexão sem senha, modelo escolhido,
 * descrições de contexto, histórico das últimas perguntas e registros da avaliação. A senha NUNCA é
 * gravada — ela existe apenas na memória, enquanto a página está aberta.
 * ========================================================================== */
const $ = id => document.getElementById(id);

/* ---------- utilidades ---------- */
// Persistência simples no navegador; em modo privado pode falhar — ignoramos.
const store = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
};
// Escapa HTML antes de montar qualquer conteúdo dinâmico (tabela de resultados,
// lista de tabelas). Evita que um dado do banco ou do modelo injete HTML.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&" + "amp;", "<": "&" + "lt;", ">": "&" + "gt;", '"': "&" + "quot;" }[c]));

/* ---------- estado da sessão (só na memória da página) ---------- */
let db = null;      // esquema lido do Firebird: { tables: [{ name, columns: [{ name, type, pk, fk }] }] }
let ctx = { project: "", tables: {} }; // descrições escritas pelo usuário
let ctxKey = "";    // chave do localStorage das descrições (uma por banco conectado)
let sql = "";       // SQL atual (gerado pelo modelo ou editado à mão)
let checked = null; // resultado da última validação: null ou { ok, note }
let controller = null; // AbortController: permite interromper a geração
let maxRows = 200;  // limite de linhas por execução (confirmado em /api/config)
let numCtx = 8192;  // janela de contexto do modelo em tokens (confirmada em /api/config)
const NUM_PREDICT = 600; // máximo de tokens que o modelo pode escrever na resposta

/* ---------- avisos e navegação ---------- */
// Toast: aviso curto no canto inferior direito, some sozinho.
function toast(msg, type){
  const t = document.createElement("div");
  t.className = "toast " + (type || "");
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
// Menu lateral recolhível (sempre fechado em telas pequenas).
function setSide(open){
  document.body.classList.toggle("side-closed", !open);
  $("menu").setAttribute("aria-expanded", open);
  store.set("t2s.side", open);
}
// Alterna entre as telas (conexão/contexto, perguntas e avaliação dos modelos).
function show(view){
  document.querySelectorAll(".view").forEach(v => v.hidden = v.id !== "view-" + view);
  if (view === "eval") renderEval();
  document.querySelectorAll(".nav").forEach(n => n.classList.toggle("on", n.dataset.view === view));
  if (innerWidth < 768) setSide(false);
}

/* ---------- comunicação com o servidor ---------- */
async function post(path, payload){
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erro " + res.status);
  return data;
}
// Traduz erros técnicos para mensagens que orientam o usuário.
function explain(err){
  if (err.name === "AbortError") return "Geração interrompida.";
  if (err instanceof TypeError) return "Servidor indisponível. Rode `npm start` e abra http://localhost:3000.";
  // Falha do próprio Ollama ao usar a GPU (ex.: "llama-server process has terminated ...
  // CUDA error"). Não é erro do SQL nem do modelo: é o processo do Ollama que caiu.
  if (/(llama-server|llama runner) process has terminated|CUDA error|cudaMalloc|0xc0000409/i.test(err.message))
    return "O Ollama travou ao usar a placa de vídeo (falha de CUDA/driver, não do SQL). Feche o Ollama pelo ícone da bandeja e abra de novo; se repetir, reinicie o computador e atualize o driver da NVIDIA. Detalhe: " + err.message;
  return err.message;
}

/* ---------- conexão com o Firebird ---------- */
async function connect(){
  const cfg = {
    host: $("host").value.trim(), port: $("port").value.trim(), database: $("database").value.trim(),
    user: $("user").value.trim(), password: $("password").value
  };
  if (!cfg.host || !cfg.database || !cfg.user) return toast("Informe servidor, caminho do banco e usuário.", "error");
  const msg = $("conn-msg");
  $("connect").disabled = true; msg.style.color = ""; msg.textContent = "Conectando…";
  try{
    // O servidor conecta, lê o esquema e devolve { tables: [...] }.
    db = await post("/api/connect", cfg);
    // Guarda a conexão SEM a senha, para preencher o formulário na próxima vez.
    store.set("t2s.conn", { host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user });
    // As descrições de contexto são guardadas por banco (host:porta/caminho).
    ctxKey = `t2s.ctx.${cfg.host}:${cfg.port}/${cfg.database}`;
    ctx = store.get(ctxKey, { project: "", tables: {} });
    ctx.examples ??= []; // contextos salvos antes dos exemplos não têm o campo
    // Banco novo: começa sem nada selecionado (a pessoa escolhe o que interpretar).
    if (!Object.keys(ctx.tables).length) db.tables.forEach(t => {
      const c = tctx(t.name); c.include = false;
      c.skip = Object.fromEntries(t.columns.map(col => [col.name, true]));
    });
    setStep(hasInterpretation() ? "rev" : "sel");
    renderContext();
    renderExamples();
    $("ctx-card").hidden = false;
    $("ex-card").hidden = false;
    $("nav-ask").disabled = false;
    $("dbstate").className = "on";
    $("dbstate").textContent = `Conectado a ${cfg.database} em ${cfg.host}. ${db.tables.length} tabela(s).`;
    msg.style.color = "var(--ok)"; msg.textContent = `Conectado. ${db.tables.length} tabela(s) encontrada(s).`;
  }catch(err){
    msg.style.color = "var(--bad)"; msg.textContent = explain(err);
  }finally{
    $("connect").disabled = false;
  }
}

/* ---------- contexto das tabelas e colunas ---------- */
// Fluxo da tela 1 em três etapas (skill de análise do banco):
//   1. "sel": a pessoa escolhe as tabelas/colunas que o modelo vai interpretar
//      (as mesmas serão usadas depois nas perguntas) e classifica cada coluna
//      como Segura, Sensível ou Desconhecida. Só as Seguras enviam valores.
//   2. "run": após a confirmação em um diálogo, as descrições das selecionadas
//      são apagadas (com backup JSON antes) e o modelo interpreta tabela a tabela.
//   3. "rev": a pessoa confirma, corrige ou descarta cada interpretação.
let step = "sel";
function setStep(s){
  step = s;
  $("ctx-card").dataset.step = s;
  document.querySelectorAll("#steps li").forEach(li => li.classList.toggle("on", li.dataset.s === s));
  $("to-review").hidden = !(s === "sel" && hasInterpretation()); // desistir de reinterpretar
  $("to-ask").disabled = s === "run";
  updateIaStatus();
}

// Garante que exista um objeto de contexto para a tabela (cria se faltar).
// "skip" guarda as colunas desmarcadas (ficam fora da interpretação e do prompt);
// "cls" guarda a classificação de privacidade das colunas (sem valor = desconhecida).
const tctx = name => {
  const c = (ctx.tables[name] ??= { include: true, desc: "", cols: {} });
  c.skip ??= {};
  c.cls ??= {};
  return c;
};
const colsSel = t => t.columns.filter(col => !tctx(t.name).skip[col.name]);

/* classificação de privacidade (o bloqueio real é feito pelo servidor em /api/sample) */
// Padrão de nomes que indicam dado pessoal; vem do servidor em /api/config
// (mesma lista que ele usa para bloquear). Estas colunas ficam travadas em "Sensível".
let sensRe = /(CPF|CNPJ|^RG$|^RG_|_RG$|EMAIL|E_MAIL|FONE|CELULAR|SENHA|PASSWORD|TOKEN|ENDERE|LOGRADOURO|NASC|AGENCIA|CONTA_?CORRENTE|CARTAO|SALARIO)/i;
let maskSensitive = true;
const forcedSens = (col) => maskSensitive && (sensRe.test(col.name) || col.type.startsWith("BLOB"));
const clsOf = (t, col) => forcedSens(col) ? "sensivel" : (tctx(t).cls[col.name] || "desconhecido");
const safeCols = t => colsSel(t).filter(col => clsOf(t.name, col) === "seguro").map(col => col.name);
const CLS_LABEL = { seguro: "Segura", desconhecido: "Desconhecida", sensivel: "Sensível" };

// Monta a lista de tabelas. A mesma lista serve às etapas: na seleção mostra a
// classificação de cada coluna; na revisão mostra a descrição e o estado dela
// (o CSS esconde o que não é da etapa atual).
// "abrir": nomes de tabelas a mostrar abertas (ex.: recém-interpretadas);
// as que já estavam abertas continuam abertas depois de redesenhar a lista.
function renderContext(abrir = new Set()){
  $("project").value = ctx.project || "";
  const abertas = new Set([...$("tables").querySelectorAll("details[open]")].map(d => d.dataset.t));
  $("tables").innerHTML = db.tables.map(t => {
    const c = tctx(t.name), n = esc(t.name);
    const cols = t.columns.map(col => {
      const cl = clsOf(t.name, col), trava = forcedSens(col);
      return `
      <div class="col-row">
        <label class="col-inc"><input type="checkbox" data-t="${n}" data-skip="${esc(col.name)}" ${c.skip[col.name] ? "" : "checked"} aria-label="Usar a coluna ${esc(col.name)}"><code>${esc(col.name)}</code></label>
        <small>${esc(col.type)}${col.pk ? " · chave primária" : ""}${col.fk ? " · referencia " + esc(col.fk) : ""}<span class="only-rev"> · ${cl === "seguro" ? "amostra enviada" : "sem amostra"} ${badge(t.name, col.name)}</span></small>
        <div class="col-in">
          <select class="cls only-sel cls-${cl}" data-t="${n}" data-cls="${esc(col.name)}" ${trava ? "disabled" : ""} aria-label="Privacidade de ${esc(col.name)}" title="${trava ? "Bloqueada: o nome indica dado pessoal ou binário. O servidor nunca lê os valores desta coluna." : "Só colunas Seguras enviam uma amostra de valores ao modelo."}">
            ${["seguro", "desconhecido", "sensivel"].map(k => `<option value="${k}" ${cl === k ? "selected" : ""}>${CLS_LABEL[k]}</option>`).join("")}
          </select>
          <input type="text" class="only-rev" data-t="${n}" data-c="${esc(col.name)}" placeholder="O que esta coluna significa?" value="${esc(c.cols[col.name] || "")}" aria-label="Significado de ${esc(col.name)}">
        </div>
      </div>`;
    }).join("");
    return `<div class="tbl">
      <label class="inc"><input type="checkbox" data-t="${n}" data-k="include" ${c.include ? "checked" : ""}> usar</label>
      <details data-t="${n}" ${abertas.has(t.name) || abrir.has(t.name) ? "open" : ""}><summary>${n}<small>${t.columns.length} colunas</small><span class="only-rev"> ${badge(t.name, TBL)}</span></summary>
        <div class="tbl-body">
          <div class="col-bulk">Colunas: <button class="link" type="button" data-t="${n}" data-cols="1">marcar todas</button><button class="link" type="button" data-t="${n}" data-cols="0">desmarcar todas</button>
            <span class="only-sel">· privacidade: <button class="link" type="button" data-t="${n}" data-allcls="seguro">todas seguras</button><button class="link" type="button" data-t="${n}" data-allcls="desconhecido">todas desconhecidas</button></span>
            <span class="only-rev">· <button class="link" type="button" data-t="${n}" data-ia="1" title="Interpreta de novo só os campos vazios ou ainda não confirmados desta tabela.">interpretar esta tabela de novo</button><button class="link" type="button" data-t="${n}" data-acc="1">confirmar todas desta tabela</button></span></div>
          <div class="desc-row only-rev"><input type="text" data-t="${n}" data-k="desc" placeholder="O que esta tabela representa?" value="${esc(c.desc)}" aria-label="Descrição de ${n}"></div>
          ${cols}
        </div></details></div>`;
  }).join("");
  updateCount();
  updateIaStatus();
}
// Resumo da seleção: tabelas e colunas marcadas, e quantas enviam amostra.
function updateCount(){
  const on = db.tables.filter(t => tctx(t.name).include);
  const cols = on.reduce((s, t) => s + colsSel(t).length, 0);
  const seg = on.reduce((s, t) => s + safeCols(t).length, 0);
  $("ctx-count").textContent = `${on.length} de ${db.tables.length} tabela(s) marcada(s) · ${cols} coluna(s) · ${seg} com amostra de valores (Seguras).`;
}
// Marca/desmarca todas as colunas de UMA tabela, sem redesenhar a lista
// (assim a tabela continua aberta enquanto a pessoa ajusta as colunas).
function setCols(tblEl, t, on){
  const c = tctx(t);
  tblEl.querySelectorAll("input[data-skip]").forEach(el => {
    el.checked = on;
    if (on) delete c.skip[el.dataset.skip]; else c.skip[el.dataset.skip] = true;
  });
}
// Botões "Marcar todas"/"Desmarcar todas": valem para todas as tabelas e colunas.
function setAll(on){
  db.tables.forEach(t => {
    const c = tctx(t.name);
    c.include = on;
    c.skip = on ? {} : Object.fromEntries(t.columns.map(col => [col.name, true]));
  });
  store.set(ctxKey, ctx);
  renderContext();
}
// Confirma (como CONFIRMADA) todas as interpretações pendentes das tabelas dadas.
function confirmAll(tables){
  let n = 0;
  tables.forEach(t => {
    const c = tctx(t.name);
    Object.keys(c.src || {}).forEach(k => { if (c.src[k] === "ia"){ c.src[k] = "ok"; updateBadge(t.name, k); n++; } });
  });
  store.set(ctxKey, ctx); updateIaStatus();
  return n;
}
// Cliques na lista: confirmar interpretação, links de cada tabela.
function onContextClick(e){
  const ok = e.target.closest("button[data-ok]");
  if (ok){ // confirmar uma interpretação sem editar
    e.preventDefault(); // o botão pode estar dentro do <summary>: não abre/fecha a tabela
    tctx(ok.dataset.bt).src[ok.dataset.bk] = "ok";
    store.set(ctxKey, ctx); updateBadge(ok.dataset.bt, ok.dataset.bk); updateIaStatus();
    return;
  }
  const ia = e.target.closest("button[data-ia]");
  if (ia){ if (!iaCtrl) interpret(db.tables.filter(t => t.name === ia.dataset.t)); return; }
  const acc = e.target.closest("button[data-acc]");
  if (acc){ confirmAll(db.tables.filter(t => t.name === acc.dataset.t)); return; }
  const all = e.target.closest("button[data-allcls]");
  if (all){ // privacidade de todas as colunas da tabela (as travadas continuam Sensíveis)
    const t = db.tables.find(x => x.name === all.dataset.t), c = tctx(t.name);
    t.columns.forEach(col => { if (all.dataset.allcls === "desconhecido") delete c.cls[col.name]; else c.cls[col.name] = all.dataset.allcls; });
    store.set(ctxKey, ctx); renderContext();
    return;
  }
  const b = e.target.closest("button[data-cols]");
  if (!b) return;
  setCols(b.closest(".tbl"), b.dataset.t, b.dataset.cols === "1");
  store.set(ctxKey, ctx); updateCount(); updateIaStatus();
}
// Salva cada alteração no localStorage (uma por uma, sem botão salvar).
function onContextInput(e){
  const el = e.target, t = el.dataset.t;
  if (!t) return;
  const c = tctx(t);
  if (el.dataset.k === "include"){
    c.include = el.checked;
    // Marcar uma tabela com todas as colunas desmarcadas (ex.: depois de
    // "Desmarcar todas") marca as colunas dela; depois é só tirar as que não interessam.
    const tbl = db.tables.find(x => x.name === t);
    if (el.checked && tbl.columns.every(col => c.skip[col.name])) setCols(el.closest(".tbl"), t, true);
  }
  else if ("skip" in el.dataset){ if (el.checked) delete c.skip[el.dataset.skip]; else c.skip[el.dataset.skip] = true; }
  else if ("cls" in el.dataset){
    if (el.value === "desconhecido") delete c.cls[el.dataset.cls]; else c.cls[el.dataset.cls] = el.value;
    el.className = `cls only-sel cls-${el.value}`;
  }
  else if (el.dataset.k === "desc" || el.dataset.c){
    const k = el.dataset.c || TBL;
    if (el.dataset.c) c.cols[k] = el.value; else c.desc = el.value;
    // Editar uma interpretação do modelo a CONFIRMA (como "editada");
    // apagar o texto descarta a interpretação (volta a pendente).
    if (!el.value.trim()){ if (c.src) delete c.src[k]; if (c.conf) delete c.conf[k]; }
    else if (["ia", "ok"].includes(srcOf(c, k))) c.src[k] = "edit";
    else if (srcOf(c, k) === "nd") delete c.src[k]; // "desconhecida" que a pessoa descreveu
    if (e.type === "change"){ updateBadge(t, k); updateIaStatus(); } // atualiza a marca ao sair do campo
  }
  store.set(ctxKey, ctx);
  updateCount();
  if (e.type === "change" && !el.dataset.c && el.dataset.k !== "desc") updateIaStatus();
}

/* ---------- interpretação do banco pelo modelo (descrições para revisão humana) ---------- */
// Etapa A da skill: o modelo lê a estrutura (nomes, tipos, chaves,
// relacionamentos) e, só das colunas Seguras, uma amostra de valores; devolve
// o significado da tabela e de cada coluna. Padrão: o próprio SQLCoder, que
// responde no formato que conhece (comandos COMMENT ON do Firebird). Alternativa
// opcional: o modelo de uso geral DESC_MODEL (ex.: gemma4:e4b), que responde em JSON.
// Não é treinamento: os pesos do modelo não mudam. O resultado vira o contexto
// (dicionário semântico) enviado ao SQLCoder junto com cada pergunta.
// Origem de cada descrição (src[chave]) e nível exibido (níveis da skill):
//   "ia"   -> INFERIDA: interpretada pelo modelo, aguardando confirmação
//   "ok"   -> CONFIRMADA: confirmada sem edição
//   "edit" -> CONFIRMADA: interpretada e corrigida pela pessoa
//   "nd"   -> DESCONHECIDA: o modelo não conseguiu interpretar
//   sem src, com texto -> CONFIRMADA: escrita pela pessoa
//   sem src, vazia     -> PENDENTE: ainda não interpretada
// A chave da descrição da tabela é TBL; a das colunas é o nome da coluna.
// Decisão do autor: todas as descrições com texto (confirmadas ou não) vão para o SQLCoder.
const TBL = "@tabela";
const SQLCODER = "__sqlcoder__"; // valor do seletor "Modelo da interpretação"
let descModel = "gemma4:e4b"; // alternativa opcional, confirmada em /api/config
let iaCtrl = null;           // AbortController da interpretação em andamento
const srcOf = (c, k) => (c.src ||= {})[k];
const CONF = { alta: "alta", media: "média", "média": "média", baixa: "baixa" };
// Modelo que faz a interpretação: SQLCoder = o mesmo escolhido para as perguntas.
const interpModel = () => $("interp-model").value === SQLCODER ? ($("model").value || "sqlcoder:7b") : descModel;
const usesSQLCoder = () => $("interp-model").value === SQLCODER;

function levelOf(t, k){
  const c = tctx(t), s = srcOf(c, k), txt = k === TBL ? c.desc : c.cols[k];
  if (s === "ia") return "INFERIDA";
  if (s === "ok" || s === "edit") return "CONFIRMADA";
  if (s === "nd") return "DESCONHECIDA";
  return (txt || "").trim() ? "CONFIRMADA" : "PENDENTE";
}
// Marca exibida ao lado de cada descrição. INFERIDA = botão "confirmar".
function badge(t, k){
  const c = tctx(t), s = srcOf(c, k), lv = levelOf(t, k), conf = CONF[(c.conf || {})[k]] || "";
  const at = `data-bt="${esc(t)}" data-bk="${esc(k)}"`;
  if (lv === "INFERIDA") return `<button type="button" class="ia pend" ${at} data-ok="1" title="Interpretação do modelo${conf ? " (confiança " + conf + ")" : ""}. Clique para confirmar sem editar; edite o texto para corrigir ou apague para descartar.">INFERIDA${conf === "baixa" ? " · incerta" : ""} · confirmar</button>`;
  if (lv === "CONFIRMADA") return `<span class="ia ok" ${at} title="${s === "edit" ? "Interpretação corrigida por você" : s === "ok" ? "Interpretação confirmada por você" : "Escrita por você"}">CONFIRMADA${s === "edit" ? " · editada" : !s ? " · sua" : ""}</span>`;
  if (lv === "DESCONHECIDA") return `<span class="ia nd" ${at} title="O modelo não conseguiu interpretar. Descreva você mesmo ou interprete de novo.">DESCONHECIDA</span>`;
  return `<span class="ia pd" ${at} title="Ainda não interpretada.">PENDENTE</span>`;
}
function updateBadge(t, k){
  for (const el of $("tables").querySelectorAll(".ia"))
    if (el.dataset.bt === t && el.dataset.bk === k){ el.outerHTML = badge(t, k); break; }
}
// Resumo dos níveis nas tabelas/colunas selecionadas (útil para a avaliação do TCC).
function updateIaStatus(){
  if (!db) return;
  const n = { CONFIRMADA: 0, INFERIDA: 0, DESCONHECIDA: 0, PENDENTE: 0 };
  marked().forEach(t => [TBL, ...colsSel(t).map(col => col.name)].forEach(k => n[levelOf(t.name, k)]++));
  const meta = ctx.interp ? `Última interpretação: ${ctx.interp.modelo}, ${new Date(ctx.interp.em).toLocaleString("pt-BR")}` : "";
  $("interp-meta").textContent = step === "sel" ? "" : meta;
  $("ia-summary").textContent = step === "sel" ? "" :
    `Nas selecionadas: ${n.CONFIRMADA} confirmada(s) · ${n.INFERIDA} inferida(s) aguardando confirmação · ${n.DESCONHECIDA} desconhecida(s) · ${n.PENDENTE} pendente(s).`;
  $("confirm-all").disabled = !n.INFERIDA;
}

// Pede a amostra ao servidor só das colunas Seguras (o servidor reforça o bloqueio).
const getSample = t => post("/api/sample", { table: t.name, safe: safeCols(t) });
const sampleText = s => s.omitted ? `valores não enviados (${s.omitted})`
  : s.values && s.values.length ? "exemplos: " + s.values.map(v => JSON.stringify(v)).join(", ") + (s.nulls ? ` (+${s.nulls} vazios)` : "")
  : "sem valores na amostra";
// Relacionamentos declarados que envolvem a tabela (entrando e saindo).
const relsOf = t => [
  ...t.columns.filter(col => col.fk).map(col => `${t.name}.${col.name} referencia ${col.fk}`),
  ...db.tables.flatMap(o => o.columns.filter(col => col.fk && col.fk.startsWith(t.name + "(")).map(col => `${o.name}.${col.name} referencia ${col.fk}`))
];

/* --- interpretação pelo SQLCoder: pede comandos COMMENT ON do Firebird --- */
// O SQLCoder foi treinado só para escrever SQL; por isso a interpretação é
// pedida como SQL que documenta a tabela (COMMENT ON TABLE/COLUMN ... IS '...'),
// no mesmo formato de prompt usado nas perguntas. A resposta é lida por
// expressão regular; o que ele não comentar fica DESCONHECIDA.
const INTERP_BATCH = 25; // colunas por chamada (tabelas largas são divididas)
function interpPrompt(t, cols, amostra, withTable){
  const c = tctx(t.name), qn = qname(t.name);
  // Mesmo formato do buildSchema: vírgula ANTES do comentário "--" (senão o comentário a engoliria).
  const itens = [
    ...cols.map(col => {
      const atual = (c.cols[col.name] || "").trim() && levelOf(t.name, col.name) === "CONFIRMADA" ? ` | confirmed meaning: ${oneLine(c.cols[col.name])}` : "";
      return { text: `${ident(col.name)} ${col.type}${col.pk ? " PRIMARY KEY" : ""}`, note: sampleText(amostra.columns[col.name] || {}) + atual };
    }),
    ...cols.filter(col => col.fk).map(col => ({ text: `FOREIGN KEY (${ident(col.name)}) REFERENCES ${col.fk}`, note: "" }))
  ];
  const corpo = itens.map((it, i) => "    " + it.text + (i < itens.length - 1 ? "," : "") + (it.note ? " -- " + it.note : "")).join("\n");
  const rel = relsOf(t);
  const first = withTable ? `TABLE ${qn} IS '` : `COLUMN ${qn}.${ident(cols[0].name)} IS '`;
  const prefill = "COMMENT ON " + first;
  const prompt = `### Task
Generate Firebird 2.5 COMMENT ON statements that document the table ${qn} and its columns. Write every comment in Brazilian Portuguese.

### Instructions
- Write ${withTable ? "one COMMENT ON TABLE statement, then " : ""}one COMMENT ON COLUMN statement for each column listed below, in the same order, and nothing else.
- Each comment explains in Brazilian Portuguese, in at most 20 words, what the ${withTable ? "table or " : ""}column means for the business.
- Use only the names, types, keys, relationships and example values shown. Do not invent business rules.
- When example values look like codes (for example 'S'/'N' or 1/2/3), say the probable meaning of each code.
- If the meaning cannot be deduced, start the comment with 'Incerto:'.
- Escape single quotes inside a comment by doubling them.

### Database Schema
${ctx.project.trim() ? "-- Contexto do projeto: " + oneLine(ctx.project) + "\n" : ""}${(c.desc || "").trim() && levelOf(t.name, TBL) === "CONFIRMADA" ? "-- Tabela " + t.name + " (significado confirmado): " + oneLine(c.desc) + "\n" : ""}CREATE TABLE ${qn} (
${corpo}
);
${rel.length ? "-- Relacionamentos: " + rel.join("; ") + "\n" : ""}-- Amostra de ${amostra.rows} linha(s); valores só das colunas classificadas como seguras.

### Answer
Given the database schema, here are the COMMENT ON statements that document ${qn}:
[SQL]
${prefill}`;
  return { prompt, prefill };
}
// Lê os COMMENT ON da resposta: { table: "texto", cols: Map(NOME -> "texto") }.
function parseComments(txt){
  const out = { table: "", cols: new Map() };
  const re = /COMMENT\s+ON\s+(TABLE|COLUMN)\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)\s+IS\s+'((?:[^']|'')*)'/gi;
  for (const m of txt.matchAll(re)){
    const v = m[3].replace(/''/g, "'").replace(/\s+/g, " ").trim();
    if (!v) continue;
    if (/^table$/i.test(m[1])){ if (!out.table) out.table = v; }
    else {
      const nm = m[2].split(".").pop().replace(/"/g, "").trim().toUpperCase();
      if (!out.cols.has(nm)) out.cols.set(nm, v);
    }
  }
  return out;
}
async function ollamaJSON(body, signal){
  const res = await fetch("/ollama/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 404
    ? `Modelo "${body.model}" não encontrado no Ollama. Veja os nomes com "ollama list" ou instale com "ollama pull ${body.model}".`
    : d.error || "Erro " + res.status);
  return d;
}
// Aplica uma interpretação a um campo, sem nunca sobrescrever o que já está CONFIRMADO.
function applyInterp(t, k, txt, conf){
  const c = tctx(t.name); c.src ||= {}; c.conf ||= {};
  if (levelOf(t.name, k) === "CONFIRMADA") return 0;
  if (!txt){ if (k === TBL) c.desc = ""; else c.cols[k] = ""; c.src[k] = "nd"; delete c.conf[k]; return 0; }
  if (k === TBL) c.desc = txt; else c.cols[k] = txt;
  c.src[k] = "ia"; c.conf[k] = conf || (/^incerto\s*:/i.test(txt) ? "baixa" : ""); if (!c.conf[k]) delete c.conf[k];
  return 1;
}
// Interpreta UMA tabela com o SQLCoder. Devolve quantas descrições aplicou.
async function interpretSQLCoder(t, signal){
  const model = interpModel(), cols = colsSel(t);
  const amostra = await getSample(t);
  let n = 0, cortado = false;
  const achadas = { table: "", cols: new Map() };
  for (let i = 0; i < Math.max(1, cols.length); i += INTERP_BATCH){
    const lote = cols.slice(i, i + INTERP_BATCH);
    if (!lote.length && i > 0) break;
    const { prompt, prefill } = interpPrompt(t, lote.length ? lote : cols, amostra, i === 0);
    const d = await ollamaJSON({ model, prompt, raw: true, stream: false,
      options: { temperature: 0, num_predict: Math.min(4096, 150 + 60 * (lote.length + 1)), stop: ["[/SQL]"] } }, signal);
    if (d.done_reason === "length") cortado = true;
    const p = parseComments(prefill + (d.response || ""));
    if (p.table && !achadas.table) achadas.table = p.table;
    p.cols.forEach((v, k) => { if (!achadas.cols.has(k)) achadas.cols.set(k, v); });
  }
  n += applyInterp(t, TBL, achadas.table);
  for (const col of cols) n += applyInterp(t, col.name, achadas.cols.get(col.name.toUpperCase()) || "");
  tctx(t.name).ia = { modelo: model, em: new Date().toISOString() };
  store.set(ctxKey, ctx);
  if (cortado && n < cols.length + 1) throw Object.assign(new Error(`resposta cortada no limite de tokens (${n} de ${cols.length + 1} interpretadas)`), { parcial: true });
  return n;
}

/* --- alternativa opcional: modelo de uso geral (DESC_MODEL), resposta em JSON --- */
function descPrompt(t, amostra){
  const c = tctx(t.name), rel = relsOf(t);
  const linhas = colsSel(t).map(col => {
    const atual = (c.cols[col.name] || "").trim() && levelOf(t.name, col.name) === "CONFIRMADA" ? ` | já descrita pelo usuário: "${oneLine(c.cols[col.name])}"` : "";
    return `- ${col.name} ${col.type}${col.pk ? " CHAVE PRIMÁRIA" : ""} | ${sampleText(amostra.columns[col.name] || {})}${atual}`;
  });
  const descAtual = c.desc.trim() && levelOf(t.name, TBL) === "CONFIRMADA" ? `\nDescrição da tabela escrita pelo usuário: "${oneLine(c.desc)}"` : "";
  return `Você é um analista de dados. Explique em português do Brasil o que representa a tabela ${t.name} de um banco Firebird e o que significa cada coluna.
Contexto do sistema: ${oneLine(ctx.project || "") || "não informado"}${descAtual}
Relacionamentos: ${rel.length ? rel.join("; ") : "nenhum declarado"}
Colunas (nome, tipo e valores de uma amostra de ${amostra.rows} linha(s); só colunas classificadas como seguras têm valores):
${linhas.join("\n")}

Regras:
- Baseie-se apenas nos nomes, tipos, relacionamentos e valores mostrados. Não invente regras de negócio.
- Quando os valores parecerem códigos (ex.: S/N, 1/2/3), diga o significado provável de cada código.
- Se não for possível deduzir o significado, comece a descrição com "Incerto:" e use confiança "baixa".
- Use as descrições já escritas pelo usuário como verdade.
- Seja breve: no máximo 20 palavras por coluna.
Responda somente com JSON, exatamente neste formato, com todas as colunas:
{"tabela":{"descricao":"...","confianca":"alta|media|baixa"},"colunas":{"NOME_DA_COLUNA":{"descricao":"...","confianca":"alta|media|baixa"}}}`;
}
async function interpretTable(t, signal){
  const amostra = await getSample(t);
  const d = await ollamaJSON({ model: descModel, prompt: descPrompt(t, amostra), stream: false, format: "json",
    options: { temperature: 0, num_predict: 4096 } }, signal);
  let j;
  try{ j = JSON.parse(d.response); }catch{ throw new Error("o modelo não devolveu um JSON válido"); }
  const conf = v => CONF[norm(v)] ? norm(v).replace("média", "media") : "";
  const td = j && j.tabela && typeof j.tabela.descricao === "string" ? j.tabela.descricao.trim() : "";
  let n = applyInterp(t, TBL, td, td && conf(j.tabela.confianca));
  const cols = new Map(Object.entries((j && j.colunas) || {}).map(([k, v]) => [k.toUpperCase(), v]));
  for (const col of colsSel(t)){
    const s = cols.get(col.name.toUpperCase());
    const txt = s && typeof s.descricao === "string" ? s.descricao.trim() : "";
    n += applyInterp(t, col.name, txt, txt && conf(s.confianca));
  }
  tctx(t.name).ia = { modelo: descModel, em: new Date().toISOString() };
  store.set(ctxKey, ctx);
  return n;
}

/* --- etapa 1 -> 2: confirmação, backup, limpeza e interpretação --- */
// Quantas descrições existem hoje nas tabelas/colunas selecionadas.
const existingDescs = tables => tables.reduce((s, t) => s + ((tctx(t.name).desc || "").trim() ? 1 : 0) +
  colsSel(t).filter(col => (tctx(t.name).cols[col.name] || "").trim()).length, 0);
function askInterpret(){
  const tables = marked();
  if (!tables.length) return toast("Marque ao menos uma tabela (com colunas) para interpretar.", "error");
  const cols = tables.reduce((s, t) => s + colsSel(t).length, 0);
  const seg = tables.reduce((s, t) => s + safeCols(t).length, 0);
  const ex = existingDescs(tables);
  $("dlg-ia-body").innerHTML = `<p><strong>${tables.length}</strong> tabela(s) e <strong>${cols}</strong> coluna(s) serão interpretadas por <strong>${esc(interpModel())}</strong>, uma tabela por vez.</p>
    <p>${seg ? `<strong>${seg}</strong> coluna(s) Seguras enviam uma amostra de até ${sampleRows} linhas;` : "Nenhuma coluna está classificada como Segura:"} as demais enviam só nome, tipo e chaves.</p>
    ${ex ? `<p class="warn">As <strong>${ex}</strong> descrição(ões) atuais destas tabelas/colunas (inclusive as escritas por você) serão <strong>apagadas</strong>. Antes disso, um backup do contexto em JSON será baixado (pode ser recuperado em "Importar contexto").</p>` : ""}
    ${tables.length > 15 ? `<p class="hint">Com muitas tabelas a interpretação pode levar bastante tempo, sobretudo com o 15B. Você pode parar a qualquer momento.</p>` : ""}`;
  $("dlg-ia").showModal();
}
async function runInterpretation(){
  const tables = marked();
  if (existingDescs(tables)) exportContext("backup");
  // Limpa o que o modelo "sabia" (as descrições) só das tabelas/colunas selecionadas.
  tables.forEach(t => {
    const c = tctx(t.name); c.src ||= {}; c.conf ||= {};
    c.desc = ""; delete c.src[TBL]; delete c.conf[TBL];
    colsSel(t).forEach(col => { c.cols[col.name] = ""; delete c.src[col.name]; delete c.conf[col.name]; });
  });
  ctx.interp = { modelo: interpModel(), em: new Date().toISOString(), tabelas: tables.length };
  store.set(ctxKey, ctx);
  setStep("run");
  renderContext();
  await interpret(tables);
  setStep("rev");
}

// Interpreta uma lista de tabelas, uma por vez, mostrando o progresso.
async function interpret(tables){
  if (!tables.length) return toast("Marque ao menos uma tabela para interpretar.", "error");
  iaCtrl = new AbortController();
  $("ia-all").disabled = true; $("ia-stop").hidden = false;
  const st = $("ia-status"), falhas = [], abrir = new Set(), model = interpModel();
  const fn = usesSQLCoder() ? interpretSQLCoder : interpretTable;
  let total = 0, feitas = 0;
  try{
    for (const t of tables){
      st.textContent = `Interpretando ${feitas + 1} de ${tables.length}: ${t.name} (com ${model})… A primeira chamada é mais lenta: o modelo é carregado na memória.`;
      try{ const n = await fn(t, iaCtrl.signal); total += n; abrir.add(t.name); }
      catch(err){
        if (err.name === "AbortError") throw err;
        falhas.push(`${t.name}: ${explain(err)}`);
        if (err.parcial) abrir.add(t.name);
        if (/não encontrado no Ollama|Ollama indisponível|Ollama travou|Nenhum banco|Servidor indisponível/.test(explain(err))) break; // não adianta seguir
      }
      feitas++;
      renderContext(abrir);
    }
    st.textContent = `Concluído: ${total} interpretação(ões) em ${feitas} tabela(s). Confirme, corrija ou descarte as marcadas como INFERIDA.` +
      (falhas.length ? ` Falhas: ${falhas.join(" | ")}` : "");
    if (falhas.length) toast("Algumas tabelas não foram interpretadas por completo.", "error");
  }catch(err){
    st.textContent = err.name === "AbortError" ? `Interrompido. ${total} interpretação(ões) aplicadas em ${feitas} tabela(s).` : explain(err);
  }finally{
    renderContext(abrir);
    $("ia-all").disabled = false; $("ia-stop").hidden = true; iaCtrl = null;
  }
}

/* ---------- exportar / importar o contexto (JSON) ---------- */
// O contexto (descrições, origens, seleção de tabelas/colunas e exemplos) fica
// no navegador; o arquivo serve de backup e para repetir testes com o mesmo
// contexto na avaliação. Importar SUBSTITUI o contexto do banco conectado.
// Já houve interpretação (ou descrições) neste banco? Decide a etapa inicial.
const hasInterpretation = () => !!ctx.interp || Object.values(ctx.tables).some(c =>
  (c.desc || "").trim() || Object.values(c.cols || {}).some(v => (v || "").trim()));
function exportContext(sufixo){
  const dados = { formato: "t2s-contexto", versao: 1, banco: ctxKey.replace(/^t2s\.ctx\./, ""), exportadoEm: new Date().toISOString(), contexto: ctx };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(dados, null, 2)], { type: "application/json" }));
  const base = (ctxKey.split(/[\\/]/).pop() || "banco").replace(/\.fdb$/i, "").replace(/[^\w-]+/g, "_");
  a.download = `contexto-${base}-${sufixo ? sufixo + "-" : ""}${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importContext(file){
  try{
    const j = JSON.parse(await file.text());
    if (j.formato !== "t2s-contexto" || !j.contexto || typeof j.contexto.tables !== "object") throw new Error("arquivo não é um contexto exportado por esta ferramenta");
    ctx = { project: "", tables: {}, examples: [], ...j.contexto };
    ctx.examples ||= [];
    store.set(ctxKey, ctx);
    setStep(hasInterpretation() ? "rev" : "sel");
    renderContext(); renderExamples();
    const outro = j.banco && j.banco !== ctxKey.replace(/^t2s\.ctx\./, "");
    toast(outro ? `Contexto importado (exportado de outro banco: ${j.banco}).` : "Contexto importado.", outro ? "error" : "success");
  }catch(err){
    toast("Não foi possível importar: " + err.message, "error");
  }
}

/* ---------- montagem do prompt (esquema + descrições -> SQLCoder) ---------- */
// Nomes fora do padrão do Firebird (minúsculas, espaços, acentos) recebem aspas.
const ident = n => /^[A-Z_][A-Z0-9_$]*$/.test(n) ? n : `"${n}"`;
const qname = n => n.split(".").map(ident).join(".");

// Instruções enviadas ao SQLCoder, uma por linha, na seção "### Instructions"
// (formato oficial do modelo). Incluem as regras de dialeto do Firebird 2.5 que
// o modelo costuma esquecer. Observações de uso real que motivaram regras:
// - TRUE/FALSE: sem a regra, o modelo usa booleanos e o Firebird recusa;
// - colunas repetidas: o modelo entrou em loop repetindo "itens.nome";
// - consulta "inchada": para "clientes ativos" o modelo acertou CLIENTE = 'S' e
//   depois inventou filtros e subconsultas sobre colunas sem relação com a pergunta;
// - "I do not know": resposta prevista pelo SQLCoder para perguntas impossíveis
//   com o esquema enviado (tratada em generate()).
// Removida: uma regra extra ("se um termo da pergunta não casar com nenhuma
// coluna, responda I do not know") fez o 7B desistir de praticamente toda
// pergunta: ele fechava a resposta sem escrever SQL (4 tokens, resposta vazia).
const INSTRUCTIONS = [
  "The query must run on Firebird 2.5. Return a single SELECT query.",
  "Use only the tables and columns in the schema below and never invent names. The comments describe what tables and columns mean.",
  "Select only the columns needed to answer the question. Never repeat a column.",
  "Keep the query as simple as possible: add only the filters the question asks for. Do not add extra conditions, subqueries or ORDER BY that the question does not request.",
  "There is no LIMIT: use SELECT FIRST n. There is no ILIKE: use UPPER(col) LIKE UPPER('%x%') or CONTAINING.",
  "There are no window functions (OVER, PARTITION BY).",
  "There is NO boolean type: never write TRUE or FALSE. Compare flag columns with their real values (for example 1, 0, 'S', 'N').",
  "For dates use DATEDIFF(DAY FROM a TO b), DATEADD(DAY, n, d) and EXTRACT(YEAR FROM d). Concatenate strings with ||.",
  "If you cannot answer the question with the available database schema, return 'I do not know'."
];
const MAX_EXAMPLES = 3; // exemplos enviados por pergunta (cada um ocupa espaço no prompt)

const oneLine = s => s.replace(/\s+/g, " ").trim();

// Gera o DDL enviado ao modelo. As descrições escritas pelo usuário entram como
// comentários ao lado de cada tabela/coluna — é assim que o modelo aprende o
// significado dos dados (a ferramenta não inventa: só envia o que existe).
// Tabelas marcadas que têm ao menos uma coluna marcada.
const marked = () => db.tables.filter(t => tctx(t.name).include && t.columns.some(col => !tctx(t.name).skip[col.name]));

function buildSchema(tables = marked()){
  const out = [];
  // Colunas que realmente vão para o modelo (tabela enviada + coluna marcada),
  // no formato "TABELA(COLUNA)", igual ao campo fk lido do banco.
  const enviadas = new Set();
  tables.forEach(t =>
    t.columns.filter(col => !tctx(t.name).skip[col.name]).forEach(col => enviadas.add(`${t.name}(${col.name})`)));
  if (ctx.project.trim()) out.push("-- Contexto do projeto: " + oneLine(ctx.project) + "\n");
  tables.forEach(t => {
    const c = tctx(t.name);
    const cols = t.columns.filter(col => !c.skip[col.name]); // só as colunas marcadas
    if (!cols.length) return; // tabela sem nenhuma coluna marcada fica de fora
    if (c.desc.trim()) out.push("-- Tabela " + t.name + ": " + oneLine(c.desc));
    const items = cols.map(col => ({
      text: `${ident(col.name)} ${col.type}${col.pk ? " PRIMARY KEY" : ""}`,
      note: oneLine(c.cols[col.name] || "")
    }));
    // Só envia a chave estrangeira se a tabela/coluna de destino também for enviada.
    // Antes, um FK para uma tabela DESMARCADA (ex.: CADRECEBER -> CADPESSOA) ia no
    // prompt e o modelo fazia JOIN com uma tabela que a pessoa decidiu não usar.
    cols.filter(col => col.fk && enviadas.has(col.fk)).forEach(col =>
      items.push({ text: `FOREIGN KEY (${ident(col.name)}) REFERENCES ${col.fk}`, note: "" }));
    out.push(`CREATE TABLE ${qname(t.name)} (\n` +
      items.map((it, i) => "    " + it.text + (i < items.length - 1 ? "," : "") + (it.note ? " -- " + it.note : "")).join("\n") +
      "\n);\n");
  });
  return out.join("\n").trim();
}

/* ---------- seleção automática de tabelas pela pergunta ---------- */
// Com muitas tabelas marcadas, enviar todas estoura a janela de contexto e faz o
// modelo usar tabelas que a pergunta não pediu (ex.: JOIN com CADPESSOA numa
// pergunta só sobre CADRECEBER). Aqui escolhemos, entre as MARCADAS, só as que
// têm relação com as palavras da pergunta. É uma heurística simples, sem modelo:
//   - pergunta cita o nome exato de tabelas (ex.: "cadreceber") -> só elas;
//   - senão, pontua cada palavra da pergunta em cada tabela (nome da tabela 5,
//     coluna com o MESMO nome da palavra 4, descrição da tabela 3, parte do nome
//     de uma coluna 2, descrição de coluna 1) e escolhe o menor conjunto de
//     tabelas que explica as palavras (no máximo 4).
//   Por que a coluna de mesmo nome vale mais que a descrição da tabela: em uso
//   real, "nome dos clientes" escolheu VENDA (descrição "vendas ... clientes do
//   sistema") em vez da tabela de pessoas, que tem as colunas NOME e CLIENTE.
// A comparação usa o "radical" (5 primeiras letras): clientes ~ CLIENTE, receber ~ CADRECEBER.
const MAX_AUTO_TABLES = 4;
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const stem = w => w.slice(0, 5);
// Palavras comuns em perguntas que não indicam tabela/coluna (português e inglês).
const STOP = new Set(("quais qual quem quantos quantas todos todas tudo para pelo pela pelos pelas como onde quando " +
  "maior menor maiores menores acima abaixo entre mais menos igual liste listar lista mostre mostrar consultar consulte consulta " +
  "exiba exibir traga trazer retorne retornar buscar busque quero gostaria sejam seja estao esta foram possuem possui tenham " +
  "dados registros registro informacoes cada sobre desde ultimo ultimos ultima ultimas sistema banco tabela " +
  "what which show list from than greater less more with that have many much each their them those these there where when " +
  "whose give return find select query please above below between equal records data only system database table").split(" "));
// Formas da palavra para comparar com nomes de coluna: clientes -> cliente, ativos -> ativo.
const forms = w => new Set([w, w.replace(/s$/, ""), w.replace(/es$/, "")]);
const tokens = s => (norm(s).match(/[a-z][a-z0-9_]{3,}/g) || []);
const qTokens = q => [...new Set(tokens(q).filter(w => !STOP.has(w) && !w.startsWith("cadastr")))];

function selectTables(question){
  const cand = marked();
  const toks = qTokens(question);
  const explicit = cand.filter(t => toks.includes(norm(t.name)));
  if (explicit.length) return { tables: explicit, why: "citadas na pergunta" };
  // Para cada tabela: quanto cada palavra da pergunta "casa" com ela.
  const info = cand.map(t => {
    const c = tctx(t.name), name = norm(t.name);
    const cols = t.columns.filter(col => !c.skip[col.name]);
    const colNames = cols.map(col => norm(col.name));
    const colParts = new Set(colNames.flatMap(n => [n, ...n.split("_")])); // NOME_CLIENTE -> nome, cliente
    const tdesc = new Set(tokens(c.desc).map(stem));
    const cdesc = new Set(cols.flatMap(col => tokens(c.cols[col.name])).map(stem));
    const m = new Map();
    for (const w of toks){
      const s = stem(w);
      const v = name.includes(w.slice(0, 4)) ? 5 // nome da tabela: 4 letras (vendidos ~ VENDA)
        : [...forms(w)].some(f => colParts.has(f)) ? 4
        : tdesc.has(s) ? 3
        : colNames.some(n => n.includes(s)) ? 2
        : cdesc.has(s) ? 1 : 0;
      if (v) m.set(w, v);
    }
    return { t, m };
  });
  // Ligação por chave estrangeira entre duas tabelas (usada para desempate).
  const related = (a, b) => a.columns.some(col => col.fk?.startsWith(b.name + "(")) || b.columns.some(col => col.fk?.startsWith(a.name + "("));
  // Cobertura gulosa: pega a tabela que mais explica as palavras ainda não
  // explicadas; só acrescenta outra tabela se sobrar palavra relevante (peso >= 2,
  // ou seja, nome de coluna ou mais forte) ou se ela for ligada por chave
  // estrangeira às já escolhidas (aí basta a descrição de uma coluna, peso 1).
  // Assim "clientes ativos" fica só na tabela que tem as duas coisas, mas
  // "clientes que compraram" acrescenta a tabela de vendas ligada a ela.
  const restantes = new Set(toks), chosen = [];
  while (restantes.size && chosen.length < MAX_AUTO_TABLES){
    let best = null;
    for (const x of info){
      if (chosen.includes(x)) continue;
      let sc = 0;
      for (const w of restantes) sc += x.m.get(w) || 0;
      if (!sc) continue;
      const rel = chosen.some(c => related(c.t, x.t));
      if (chosen.length && sc < 2 && !rel) continue;
      if (rel) sc += 0.5; // desempate: tabela ligada às já escolhidas
      if (!best || sc > best.sc) best = { x, sc };
    }
    if (!best) break;
    chosen.push(best.x);
    for (const w of [...restantes]) if (best.x.m.has(w)) restantes.delete(w);
  }
  return { tables: chosen.map(x => x.t), why: "escolhidas pela pergunta" };
}

// Escolhe os exemplos PARECIDOS com a pergunta; empate fica com o mais recente.
// Exemplos mostram ao modelo nomes e JOINs corretos deste banco, mas o modelo 7B
// também copia os filtros deles: em uso real, um exemplo com CLIENTE = 'S' fez o
// filtro aparecer em perguntas que não falavam de clientes. Por isso:
//   - só entram exemplos que usam apenas tabelas enviadas nesta pergunta;
//   - só entram exemplos que compartilham ao menos metade das palavras
//     relevantes da pergunta (mesma comparação por radical da seleção de tabelas).
const exTables = s => [...s.matchAll(/\b(?:from|join)\s+("[^"]+"|[\w$]+)/gi)].map(m => m[1].replace(/"/g, "").toUpperCase());
function pickExamples(question, tables){
  const qw = new Set(qTokens(question).map(stem));
  if (!qw.size) return [];
  const enviadas = new Set(tables.map(t => t.name.toUpperCase()));
  return (ctx.examples || [])
    .filter(e => exTables(e.sql).every(t => enviadas.has(t)))
    .map((e, i) => ({ e, i, score: new Set(qTokens(e.q).map(stem).filter(w => qw.has(w))).size }))
    .filter(x => x.score >= Math.max(1, qw.size / 2))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_EXAMPLES).map(x => x.e);
}

// Formato oficial do SQLCoder: tarefa, instruções, esquema e início da resposta.
// Os exemplos usam as mesmas marcas [QUESTION]/[SQL]...[/SQL] da resposta, o que
// também ensina o modelo a fechar a consulta com [/SQL] (ponto de parada).
// A data atual ajuda o modelo a interpretar "este ano", "hoje" etc.
function buildPrompt(question, schema, ex){
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const hoje = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; // data local (toISOString usaria UTC e viraria o dia à noite)
  const exText = ex.length ? `
### Examples
Correct queries already reviewed for this database. Use them only as a reference for table names, column names and style. Do not copy their filters (WHERE conditions) unless the new question asks for them:
${ex.map(e => `[QUESTION]${oneLine(e.q)}[/QUESTION]\n[SQL]${e.sql.trim()}[/SQL]`).join("\n\n")}
` : "";
  return `### Task
Generate a SQL query to answer [QUESTION]${question}[/QUESTION]

### Instructions
${INSTRUCTIONS.map(i => "- " + i).join("\n")}
- Today's date is ${hoje}.

### Database Schema
The query will run on a database with the following schema:
${schema}
${exText}
### Answer
Given the database schema, here is the SQL query that answers [QUESTION]${question}[/QUESTION]
[SQL]
`;
}
// Limpa a saída do modelo: remove blocos de código, corta no fim da consulta
// e também no caso de o modelo repetir a marca de abertura "[SQL]" no final.
// Se o modelo abrir a resposta com ```sql, o bloco é aproveitado (corta no ``` de
// fechamento); antes, "```" era ponto de parada e uma resposta que começava com
// ele terminava vazia.
const cleanSQL = raw => raw.replace(/^\s*\[SQL\]/i, "").replace(/^\s*```(?:sql)?/i, "").split("```")[0].split("[/SQL]")[0].replace(/\[SQL\]\s*$/, "").trim();

/* ---------- geração (SQLCoder via Ollama, em streaming) ---------- */
async function generate(){
  const question = $("q").value.trim();
  if (!question) return toast("Digite uma pergunta antes de gerar.", "error");
  if (!marked().length) return toast("Marque ao menos uma tabela (com colunas) em Conexão e contexto.", "error");
  // Quais tabelas vão para o modelo: escolha automática pela pergunta ou todas as marcadas.
  const sel = selectTables(question); // só as tabelas marcadas relacionadas à pergunta
  if (!sel.tables.length){
    $("used").textContent = "Nenhuma tabela marcada parece relacionada à pergunta. Cite o nome da tabela (ex.: CADRECEBER) ou descreva as tabelas em Conexão e contexto.";
    return toast("Nenhuma tabela relacionada à pergunta foi encontrada.", "error");
  }
  const ex = pickExamples(question, sel.tables);
  $("used").textContent = `Tabelas enviadas ao modelo (${sel.why}): ${sel.tables.map(t => t.name).join(", ")}` +
    ` · ${ex.length ? ex.length + " exemplo(s) parecido(s) incluído(s)" : "nenhum exemplo incluído"}`;
  const schema = buildSchema(sel.tables);

  // Estimativa grosseira (~3 caracteres por token para DDL com nomes em maiúsculas
  // e comentários em português). Se o prompt + a resposta passarem da janela de
  // contexto, o Ollama descarta o excesso SEM avisar e o modelo recebe o esquema
  // pela metade — causa típica de nomes inventados e de loops de repetição.
  const prompt = buildPrompt(question, schema, ex);
  const estimado = Math.ceil(prompt.length / 3);
  const grande = estimado + NUM_PREDICT > numCtx;

  // Nova geração: limpa estado anterior (validação e resultados antigos).
  controller = new AbortController();
  $("go").hidden = true; $("stop").hidden = false;
  sql = ""; checked = null; updateExec();
  $("out").value = ""; $("check").textContent = ""; hideResults();
  const aviso = grande ? `Prompt grande: ~${estimado} tokens para uma janela de ${numCtx} (reservando ${NUM_PREDICT} para a resposta). O excesso será descartado pelo Ollama e o SQL tende a sair errado. Desmarque tabelas que não têm relação com a pergunta ou aumente OLLAMA_NUM_CTX no .env.` : "";
  if (grande){
    $("check").className = "bad"; $("check").textContent = "! " + aviso;
    toast("Prompt provavelmente maior que o limite do modelo.", "error");
  }
  let raw = "", doneReason = "", fim = null;
  evalId = null;
  const t0 = performance.now();
  // Dados comuns do registro de avaliação desta geração.
  const base = m => ({ q: question, m, tabelas: sel.tables.map(t => t.name).join(", "), exemplos: ex.length, ms: Math.round(performance.now() - t0) });
  try{
    const model = $("model").value || "sqlcoder:7b"; // lido a cada geração: trocar o modelo não exige reconectar
    // A geração passa pelo servidor (/ollama/...), que faz o proxy ao Ollama.
    const res = await fetch("/ollama/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({
        model, prompt, raw: true, stream: true,
        options: { temperature: 0, num_predict: NUM_PREDICT, stop: ["[/SQL]"] }
      })
    });
    if (!res.ok){
      const d = (await res.json().catch(() => ({}))).error || "";
      throw new Error(res.status === 404
        ? `Modelo "${model}" não encontrado no Ollama. Veja os nomes com "ollama list" ou instale com "ollama pull ${model}".`
        : d || "Erro " + res.status);
    }
    // Lê o stream linha a linha (JSON por linha, formato do Ollama).
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    const handle = line => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      raw += msg.response || "";
      if (msg.done){ doneReason = msg.done_reason || ""; fim = msg; } // "stop" = terminou; "length" = cortado pelo limite
      $("out").value = cleanSQL(raw); // mostra o SQL conforme vai sendo gerado
    };
    for(;;){
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      lines.forEach(handle);
    }
    handle(buf + dec.decode()); // última linha, caso venha sem "\n" no final
    sql = cleanSQL(raw);
    $("out").value = sql || "-- Sem resultado.";
    if (doneReason === "length"){
      // Resposta cortada: não adianta mandar ao banco, o SQL está incompleto.
      $("check").className = "bad";
      $("check").textContent = `✕ A geração parou ao atingir o limite de ${NUM_PREDICT} tokens: o SQL está incompleto (o modelo provavelmente entrou em loop, repetindo colunas).` +
        (grande ? " O prompt também parece maior que a janela de contexto: desmarque tabelas sem relação com a pergunta." : " Tente reformular a pergunta, ou complete o SQL na caixa e clique em 'Conferir no banco'.");
      toast("SQL incompleto: geração cortada pelo limite de tamanho.", "error");
      evalId = evalNew({ ...base(model), gen: "cortado", sql });
    } else if (!sql){
      // Nenhum SQL aproveitável: mostra o que o modelo devolveu para diagnóstico.
      // JSON.stringify deixa visíveis espaços e quebras de linha soltos.
      const bruto = raw ? JSON.stringify(raw.slice(0, 300)) : "(vazia)";
      $("check").className = "bad";
      $("check").textContent = `! O modelo encerrou sem escrever SQL. No SQLCoder, isso costuma indicar que ele não achou no esquema enviado o que a pergunta pede: confira as tabelas enviadas e as descrições, ou reformule a pergunta. Resposta bruta: ${bruto}` +
        ` · motivo de parada: ${doneReason || "?"} · tokens gerados: ${fim?.eval_count ?? "?"} · tokens do prompt processados: ${fim?.prompt_eval_count ?? "?"}`;
      evalId = evalNew({ ...base(model), gen: "vazio", sql: "" });
    } else if (/i do not know/i.test(sql)){
      // O modelo declarou que o esquema enviado não basta para responder.
      $("check").className = "bad";
      $("check").textContent = "! O modelo indicou que não consegue responder com as tabelas/colunas marcadas. Marque as que a pergunta precisa, descreva-as melhor ou reformule a pergunta.";
      evalId = evalNew({ ...base(model), gen: "nao_sei", sql });
      sql = ""; updateExec();
    } else if (sql){ evalId = evalNew({ ...base(model), gen: "ok", sql }); saveHistory(question, sql, model, evalId); checkSQL(aviso); } // valida automaticamente ao terminar (mantendo o aviso de prompt grande, se houver)
  }catch(err){
    sql = cleanSQL(raw); $("out").value = sql;
    if (err.name === "AbortError"){ if (!sql) $("out").value = "-- Geração interrompida."; }
    else { $("out").value = "-- Erro: " + explain(err); toast(explain(err), "error"); }
    updateExec();
  }finally{
    $("go").hidden = false; $("stop").hidden = true; controller = null;
  }
}

/* ---------- conferência local de nomes de tabelas e colunas ---------- */
// O modelo às vezes "padroniza" nomes: escreveu COD_TIPO_PGTO quando a coluna
// real é COD_TIPOPGTO (copiou o estilo de COD_CLIENTE), ou DATA_ALTERACAO no
// lugar de DATAALTERACAO. Aqui o SQL é comparado com o esquema lido do banco e a
// ferramenta AVISA o nome provável. Decisão do autor: só avisar, sem alterar o SQL.
// Limitação: confere tabelas após FROM/JOIN e colunas escritas como
// TABELA.COLUNA ou APELIDO.COLUNA; colunas sem prefixo não são conferidas.
function lev(a, b){ // distância de edição (Levenshtein) entre dois textos curtos
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Sugere nomes reais parecidos: primeiro os iguais ignorando "_" e maiúsculas,
// depois os que diferem em até 2 letras.
function sugira(nome, reais){
  const sem = x => x.toUpperCase().replace(/_/g, "");
  let achados = reais.filter(r => sem(r) === sem(nome));
  if (!achados.length) achados = reais.filter(r => lev(r.toUpperCase(), nome.toUpperCase()) <= 2);
  return achados.length ? ` (você quis dizer ${achados.slice(0, 3).join(" ou ")}?)` : "";
}
function checkNames(text){
  if (!db) return "";
  const clean = text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");
  const unq = x => x.replace(/"/g, "").toUpperCase();
  const tabelas = new Map(db.tables.map(t => [t.name.toUpperCase(), t]));
  const ctes = new Set([...clean.matchAll(/\b([\w$]+)\s+as\s*\(/gi)].map(m => unq(m[1]))); // WITH x AS (...)
  const KW = new Set(["WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "ON", "GROUP", "ORDER", "HAVING", "UNION", "PLAN", "ROWS"]);
  const apelidos = new Map(), avisos = [];
  for (const m of clean.matchAll(/\b(?:from|join)\s+("[^"]+"|[\w$]+)(?:\s+(?:as\s+)?("[^"]+"|[\w$]+))?/gi)){
    const tn = unq(m[1]);
    if (ctes.has(tn) || /^(RDB|MON)\$/.test(tn)) continue; // CTEs e tabelas de sistema
    const t = tabelas.get(tn);
    if (!t){ avisos.push(`tabela ${tn}${sugira(tn, db.tables.map(x => x.name))}`); continue; }
    apelidos.set(tn, t);
    if (m[2] && !KW.has(unq(m[2]))) apelidos.set(unq(m[2]), t);
  }
  for (const m of clean.matchAll(/("[^"]+"|[A-Za-z_][\w$]*)\.("[^"]+"|[A-Za-z_][\w$]*)/g)){
    const t = apelidos.get(unq(m[1]));
    if (!t) continue; // apelido de subconsulta ou desconhecido: não confere
    const c = unq(m[2]);
    if (!t.columns.some(col => col.name.toUpperCase() === c))
      avisos.push(`${t.name}.${c}${sugira(c, t.columns.map(col => col.name))}`);
  }
  return [...new Set(avisos)].join("; ");
}

/* ---------- validação e execução (separadas por decisão de segurança) ---------- */
// Pede ao servidor para conferir a consulta no banco SEM executá-la
// (subselect com WHERE 1=0 em transação de leitura). "aviso" é um alerta extra
// que continua visível abaixo do resultado (ex.: prompt maior que o limite).
async function checkSQL(aviso){
  sql = $("out").value.trim(); // usa o conteúdo atual da caixa (permite edição manual)
  if (!sql){ toast("Não há SQL para validar.", "error"); return; }
  // Conferência local dos nomes (só avisa, não altera o SQL) somada ao aviso recebido.
  const nomes = checkNames(sql);
  aviso = [aviso, nomes && "Nomes que não existem no banco: " + nomes].filter(Boolean).join("\n! ");
  const el = $("check");
  el.className = ""; el.textContent = "Conferindo no banco…";
  try{
    const r = await post("/api/validate", { sql });
    checked = r; updateExec();
    // Avaliação: registra a sintaxe só na 1ª conferência do SQL como o modelo gerou.
    const ev = evalGet(evalId);
    if (ev && ev.sint === null && !ev.editado && sql === ev.sql) evalPatch(evalId, { sint: r.note ? "nc" : "ok" });
    el.className = r.note ? "" : "ok";
    el.textContent = (r.note ? "! " + r.note : "✓ O banco aceitou esta consulta (nada foi executado).") + (aviso ? "\n! " + aviso : "");
  }catch(err){
    checked = null; updateExec();
    const ev = evalGet(evalId);
    if (ev && ev.sint === null && !ev.editado && sql === ev.sql && !envError(err)) evalPatch(evalId, { sint: "erro", sintMsg: explain(err) });
    el.className = "bad"; el.textContent = "✕ O banco recusou: " + explain(err) + (aviso ? "\n! " + aviso : "");
    toast("Corrija o SQL na caixa acima (se souber o ajuste) e clique em 'Conferir no banco' de novo.", "error");
  }
}

// O botão Executar só libera com SQL presente e validação concluída com êxito —
// a execução nunca acontece sobre uma consulta que o banco já recusou.
function updateExec(){
  const ok = !!(sql && checked && checked.ok);
  $("exec").disabled = !ok;
  $("save-ex").disabled = !ok; // só vira exemplo uma consulta que o banco aceitou
  $("exec-hint").textContent = !sql ? "Gere ou edite o SQL para começar."
    : ok ? "Consulta validada. Confirme a execução no diálogo."
    : "Valide a consulta no banco para liberar a execução.";
}

// Abre o diálogo de confirmação explícita antes de qualquer execução.
function askExecute(){
  if (!sql) return toast("Gere ou informe o SQL antes de executar.", "error");
  if (!checked || !checked.ok) return toast("Valide a consulta no banco antes de executar.", "error");
  $("dlg-rows").textContent = maxRows;
  $("dlg").showModal(); // diálogo nativo: bloqueia o restante da tela até decidir
}

// Executa no servidor (transação READ ONLY + limite de linhas) e monta a tabela.
async function runQuery(){
  const card = $("res-card");
  card.hidden = false;
  $("res-meta").textContent = "";
  $("res-table").innerHTML = "";
  $("res-note").className = ""; $("res-note").textContent = "Executando…";
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try{
    const r = await post("/api/execute", { sql });
    renderResults(r);
    const ev = evalGet(evalId);
    if (ev) evalPatch(evalId, { exec: "ok", execMsg: "", linhas: r.rowCount, sqlFinal: sql, ...(ev.sint === "nc" ? { sint: "ok" } : {}) });
    renderReview(); // revisão semântica logo após a execução
  }catch(err){
    $("res-note").className = "bad";
    $("res-note").textContent = "✕ Falha na execução: " + explain(err);
    const ev = evalGet(evalId);
    if (ev && !envError(err)) evalPatch(evalId, { exec: "erro", execMsg: explain(err), sqlFinal: sql, ...(ev.sint === "nc" ? { sint: "erro", sintMsg: explain(err) } : {}) });
    renderReview();
  }
}

// Mostra os resultados: colunas, linhas, tempo gasto e avisos de limite/vazio.
function renderResults(r){
  $("res-meta").textContent = `${r.rowCount} linha(s) · ${r.elapsedMs} ms`;
  if (!r.rows.length){
    $("res-table").innerHTML = "";
    $("res-note").className = "";
    $("res-note").textContent = "A consulta não retornou linhas (conjunto vazio).";
    return;
  }
  const head = r.columns.map(c => `<th>${esc(c)}</th>`).join("");
  const body = r.rows.map(row => "<tr>" + r.columns.map(c => `<td>${esc(row[c] ?? "")}</td>`).join("") + "</tr>").join("");
  $("res-table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  $("res-note").className = r.truncated ? "bad" : "";
  $("res-note").textContent = r.truncated
    ? `! Limite de ${maxRows} linhas atingido. Refine a consulta (filtros, agregações) ou aumente MAX_ROWS no .env.`
    : "";
}
// Resultados antigos deixam de fazer sentido quando o SQL muda.
function hideResults(){ $("res-card").hidden = true; $("review").hidden = true; $("res-note").textContent = ""; $("res-table").innerHTML = ""; $("res-meta").textContent = ""; }

/* ---------- exemplos (pergunta -> SQL conferido), um conjunto por banco ---------- */
// Ficam no navegador junto com o contexto do banco conectado. Só entram
// consultas que o banco aceitou; mesmo assim, revise a lógica antes de salvar:
// um exemplo errado ensina o erro ao modelo.
function renderExamples(){
  const list = ctx.examples || [];
  $("ex-count").textContent = list.length ? `${list.length} exemplo(s); até ${MAX_EXAMPLES} vão em cada pergunta (só os que usam tabelas marcadas)` : "";
  $("examples").innerHTML = list.length
    ? list.map((e, i) => `<li><div><strong>${esc(e.q)}</strong><code>${esc(e.sql)}</code></div><button class="link" type="button" data-del="${i}">remover</button></li>`).join("")
    : '<li class="hint">Nenhum exemplo ainda. Adicione abaixo ou use "Salvar como exemplo" depois de validar uma consulta.</li>';
}
function addExample(q, s){
  ctx.examples = [{ q, sql: s }, ...(ctx.examples || []).filter(e => e.q !== q)]; // mesma pergunta: substitui
  store.set(ctxKey, ctx);
  renderExamples();
}
// Adição manual (tela 1): confere no banco antes de aceitar o exemplo.
async function addExampleManual(){
  const q = $("ex-q").value.trim(), s = $("ex-sql").value.trim().replace(/;+\s*$/, "");
  if (!q || !s) return toast("Informe a pergunta e o SQL do exemplo.", "error");
  $("ex-add").disabled = true;
  try{
    await post("/api/validate", { sql: s });
    addExample(q, s);
    $("ex-q").value = ""; $("ex-sql").value = "";
    toast("Exemplo conferido no banco e salvo.", "success");
  }catch(err){
    toast("O banco recusou o SQL do exemplo: " + explain(err), "error");
  }finally{ $("ex-add").disabled = false; }
}
// Atalho (tela 2): salva a pergunta atual com o SQL já validado.
function saveAsExample(){
  const q = $("q").value.trim();
  if (!q) return toast("Escreva a pergunta correspondente a este SQL.", "error");
  if (!sql || !checked || !checked.ok) return toast("Valide a consulta no banco antes de salvar como exemplo.", "error");
  addExample(q, sql.replace(/;+\s*$/, ""));
  toast("Salvo como exemplo. Ele será usado nas próximas perguntas parecidas.", "success");
}

/* ---------- avaliação dos modelos (tela "Avaliação dos modelos") ---------- */
// Cada geração vira um registro, guardado no navegador (t2s.eval), com o modelo
// que a produziu, para comparar o SQLCoder 7B e o 15B na avaliação do TCC.
// Sem dados do banco: guarda pergunta, SQL, situação e número de linhas.
//   gen  : "ok" | "cortado" (limite de tokens) | "vazio" (sem SQL) | "nao_sei" ("I do not know")
//   sint : null (ainda não conferido) | "ok" (banco aceitou) | "erro" (banco recusou)
//          | "nc" (WITH: o Firebird 2.5 não confere antes; vira ok/erro na execução)
//   exec : null | "ok" | "erro"
//   sem  : null (aguardando revisão) | "ok" | "erro"  -> marcação humana
// A sintaxe registrada é a do SQL como o modelo gerou: só a conferência
// automática logo após a geração conta, e nunca depois de o SQL ser editado.
// Não são registradas: gerações interrompidas pelo usuário e falhas de ambiente
// (servidor, Ollama ou banco fora do ar, modelo não instalado), que não medem o modelo.
const EVAL_KEY = "t2s.eval", EVAL_MAX = 1000;
let evalId = null; // registro da geração exibida na tela Perguntar
const evalAll = () => store.get(EVAL_KEY, []);
function evalNew(rec){
  const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(),
    banco: ctxKey.replace(/^t2s\.ctx\./, ""), sint: null, sintMsg: "", exec: null, execMsg: "", linhas: null,
    editado: false, sqlFinal: "", sem: null, semNota: "", ...rec };
  store.set(EVAL_KEY, [r, ...evalAll()].slice(0, EVAL_MAX));
  if (!$("view-eval").hidden) renderEval();
  return r.id;
}
const evalGet = id => id ? evalAll().find(r => r.id === id) || null : null;
function evalPatch(id, patch){
  if (!id) return;
  const list = evalAll(), r = list.find(x => x.id === id);
  if (!r) return;
  Object.assign(r, patch);
  store.set(EVAL_KEY, list);
  if (!$("view-eval").hidden) renderEval();
}
// Falhas que não são do SQL (servidor/banco indisponível): não contam como erro de sintaxe.
const envError = err => err instanceof TypeError || /Nenhum banco conectado|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket|conex/i.test(err.message);
const modelLabel = m => { const n = /(\d+)\s*b\b/i.exec(m || ""); return n ? `SQLCoder ${n[1]}B` : (m || "?"); };
const pct = (a, b) => b ? (a / b * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%" : "–";
const GEN_MSG = { cortado: "Geração cortada no limite de tokens (SQL incompleto)", vazio: "O modelo não escreveu SQL", nao_sei: 'O modelo respondeu "I do not know"' };

// Situação de cada registro, em categorias que não se sobrepõem (barra empilhada).
// Cores: paleta de status (verde/âmbar/vermelho) + cinza neutro para "pendente";
// a ordem foi conferida no validador de paleta (separação para daltonismo).
const CATS = [
  { k: "ok",    label: "Semântica correta",        color: "#0ca30c" },
  { k: "pend",  label: "Sintaxe ok · aguardando revisão", color: "#64748b" },
  { k: "sem",   label: "Semântica incorreta",      color: "#fab219", dark: true },
  { k: "sint",  label: "Erro de sintaxe (banco recusou)", color: "#d03b3b" },
  { k: "falha", label: "Falha na geração ou execução", color: "#a855f7" }
];
function catOf(r){
  if (r.gen !== "ok" || r.exec === "erro") return "falha";
  if (r.sint === "erro") return "sint";
  return r.sem === "ok" ? "ok" : r.sem === "erro" ? "sem" : "pend";
}
// Só faz sentido avaliar a semântica de SQL que o banco não recusou.
const canReview = r => r.gen === "ok" && r.sint !== "erro" && r.exec !== "erro";

function evalStats(list){
  const n = { total: list.length, sintOk: 0, semOk: 0, semErr: 0, erros: 0, pend: 0, cats: {} };
  CATS.forEach(c => n.cats[c.k] = 0);
  list.forEach(r => {
    n.cats[catOf(r)]++;
    if (r.sint === "ok") n.sintOk++;
    if (r.gen !== "ok" || r.sint === "erro" || r.exec === "erro") n.erros++;
    if (canReview(r)){ if (r.sem === "ok") n.semOk++; else if (r.sem === "erro") n.semErr++; else n.pend++; }
  });
  return n;
}

function renderEval(){
  const all = evalAll();
  $("ev-total").textContent = all.length ? `${all.length} pergunta(s) registrada(s)` : "";
  $("ev-legend").innerHTML = CATS.map(c => `<li><span class="sw" style="background:${c.color}"></span>${c.label}</li>`).join("");
  // Um bloco por modelo (7B e 15B sempre aparecem, mesmo sem registros).
  const models = [...new Set(["sqlcoder:7b", "sqlcoder:15b", ...all.map(r => r.m)])];
  $("ev-models").innerHTML = models.map(m => {
    const list = all.filter(r => r.m === m), s = evalStats(list);
    const rev = s.semOk + s.semErr;
    const head = `<h3>${esc(modelLabel(m))} <span>${esc(m)} · ${s.total} pergunta(s)${s.total ? " · " + s.pend + " aguardando revisão" : ""}</span></h3>`;
    if (!s.total) return `<div class="ev-model">${head}<p class="ev-none">Nenhuma pergunta gerada com este modelo ainda.</p></div>`;
    const tiles = [
      ["Perguntas", s.total, ""],
      ["Sintaxe correta", s.sintOk, pct(s.sintOk, s.total) + " do total"],
      ["Semântica correta", s.semOk, `${pct(s.semOk, s.total)} do total · ${rev ? pct(s.semOk, rev) + " das revisadas" : "nenhuma revisada"}`],
      ["Retornaram erro", s.erros, pct(s.erros, s.total) + " do total"]
    ].map(([l, v, sub]) => `<div class="tile"><small>${l}</small><b>${v}</b><i>${sub || "&nbsp;"}</i></div>`).join("");
    const segs = CATS.filter(c => s.cats[c.k]).map(c => {
      const v = s.cats[c.k], w = v / s.total * 100;
      return `<div class="seg${c.dark ? " dark" : ""}" style="flex:${v} 1 0;background:${c.color}" data-tip="${esc(`${c.label}: ${v} de ${s.total} (${pct(v, s.total)})`)}" aria-label="${esc(`${c.label}: ${v}`)}">${w >= 8 ? v : ""}</div>`;
    }).join("");
    return `<div class="ev-model">${head}<div class="tiles">${tiles}</div><div class="bar" role="img" aria-label="${esc(modelLabel(m) + ": " + CATS.map(c => `${c.label} ${s.cats[c.k]}`).join(", "))}">${segs}</div></div>`;
  }).join("");

  // Filtros da tabela (mantém a escolha ao redesenhar).
  const fm = $("ev-model"), fc = $("ev-cat"), vm = fm.value, vc = fc.value;
  fm.innerHTML = `<option value="">Todos</option>` + models.map(m => `<option value="${esc(m)}">${esc(modelLabel(m))}</option>`).join("");
  fc.innerHTML = `<option value="">Todas</option>` + CATS.map(c => `<option value="${c.k}">${c.label}</option>`).join("");
  fm.value = [...fm.options].some(o => o.value === vm) ? vm : "";
  fc.value = vc || "";
  const rows = all.filter(r => (!fm.value || r.m === fm.value) && (!fc.value || catOf(r) === fc.value));
  $("ev-empty").hidden = all.length > 0;
  $("ev-empty").textContent = "Nenhuma pergunta registrada ainda. Gere SQL na tela Perguntar: cada geração entra aqui com o modelo usado.";
  if (all.length && !rows.length){ $("ev-empty").hidden = false; $("ev-empty").textContent = "Nenhum registro com esses filtros."; }
  $("ev-table").parentElement.hidden = !rows.length;
  const dt = iso => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const mark = (ok, txt) => `<span class="st"><span class="sw" style="background:${ok === true ? "#0ca30c" : ok === false ? "#d03b3b" : "#64748b"}"></span>${txt}</span>`;
  $("ev-table").innerHTML = rows.length ? `<thead><tr><th>Quando</th><th>Modelo</th><th>Pergunta e SQL</th><th>Sintaxe</th><th>Semântica</th><th></th></tr></thead><tbody>` +
    rows.map(r => {
      const sint = r.gen !== "ok" ? mark(false, "sem SQL") : r.sint === "ok" ? mark(true, "correta") : r.sint === "erro" ? mark(false, "recusada")
        : r.sint === "nc" ? mark(null, "não conferida (WITH)") : mark(null, "não conferida");
      const sem = canReview(r)
        ? `<div class="sem-btns" role="group" aria-label="Avaliação semântica"><button class="btn rev" type="button" data-eid="${r.id}" data-sem="ok" aria-pressed="${r.sem === "ok"}" title="Correta">✓</button><button class="btn rev" type="button" data-eid="${r.id}" data-sem="erro" aria-pressed="${r.sem === "erro"}" title="Incorreta">✕</button></div>` +
          (r.sem ? "" : `<span class="mini">pendente</span>`)
        : `<span class="mini">não avaliável</span>`;
      const det = [
        r.gen !== "ok" ? GEN_MSG[r.gen] || r.gen : "",
        r.sintMsg ? "Banco: " + r.sintMsg : "",
        r.exec === "ok" ? `Executada: ${r.linhas} linha(s)` : r.exec === "erro" ? "Falha na execução: " + r.execMsg : "",
        r.editado ? "SQL editado manualmente antes de executar." : "",
        r.semNota ? "Observação: " + r.semNota : "",
        r.ms != null ? `Tempo de geração: ${(r.ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s` : "",
        r.tabelas ? "Tabelas enviadas: " + r.tabelas : ""
      ].filter(Boolean);
      return `<tr><td class="nw">${dt(r.ts)}</td><td class="nw">${esc(modelLabel(r.m))}</td>
        <td><details><summary>${esc(r.q)}</summary>${r.sql ? `<code>${esc(r.sql)}</code>` : ""}${r.editado && r.sqlFinal && r.sqlFinal !== r.sql ? `<p>SQL executado após edição:</p><code>${esc(r.sqlFinal)}</code>` : ""}${det.map(d => `<p>${esc(d)}</p>`).join("")}</details></td>
        <td>${sint}</td><td>${sem}</td><td><button class="link" type="button" data-evdel="${r.id}">remover</button></td></tr>`;
    }).join("") + "</tbody>" : "";
}

// Painel de revisão abaixo dos resultados (aparece depois de executar).
function renderReview(){
  const r = evalGet(evalId), box = $("review");
  box.hidden = !r || !canReview(r) || r.exec !== "ok";
  if (box.hidden) return;
  $("rev-model").textContent = "· gerado por " + modelLabel(r.m);
  box.querySelectorAll(".rev").forEach(b => b.setAttribute("aria-pressed", String(r.sem === b.dataset.sem)));
  $("rev-edit").hidden = !r.editado;
  $("rev-note").value = r.semNota || "";
  $("rev-msg").textContent = r.sem ? `Registrado como ${r.sem === "ok" ? "correta" : "incorreta"}. Clique de novo para desfazer; os números estão em "Avaliação dos modelos".` : "";
}
// Marca (ou desmarca, clicando de novo) a avaliação semântica de um registro.
function setSem(id, v){
  const r = evalGet(id);
  if (!r) return;
  const sem = r.sem === v ? null : v;
  evalPatch(id, { sem, semEm: sem ? new Date().toISOString() : null });
  if (id === evalId) renderReview();
  if (sem) toast(`Resposta marcada como semanticamente ${sem === "ok" ? "correta" : "incorreta"}.`, "success");
}

// Exporta os registros em CSV (";" e BOM para abrir direto no Excel em português).
function exportEval(){
  const all = evalAll();
  if (!all.length) return toast("Não há registros para exportar.", "error");
  const cols = [["data", r => r.ts], ["banco", r => r.banco], ["modelo", r => r.m], ["pergunta", r => r.q], ["tabelas_enviadas", r => r.tabelas],
    ["exemplos", r => r.exemplos], ["tempo_geracao_ms", r => r.ms], ["geracao", r => r.gen], ["sintaxe", r => r.sint], ["mensagem_banco", r => r.sintMsg],
    ["execucao", r => r.exec], ["linhas", r => r.linhas], ["mensagem_execucao", r => r.execMsg], ["editado", r => r.editado ? "sim" : "nao"],
    ["semantica", r => r.sem], ["observacao", r => r.semNota], ["situacao", r => CATS.find(c => c.k === catOf(r)).label],
    ["sql_gerado", r => r.sql], ["sql_executado", r => r.sqlFinal]];
  const cell = v => { const t = v == null ? "" : String(v); return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = "﻿" + [cols.map(c => c[0]).join(";"), ...all.map(r => cols.map(c => cell(c[1](r))).join(";"))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `avaliacao-modelos-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- histórico e cópia ---------- */
// Guarda as 10 últimas perguntas no navegador (sem dados do banco), com o
// modelo que gerou cada SQL — útil para comparar 7B e 15B na avaliação.
function saveHistory(q, s, m, e){
  store.set("t2s.history", [{ q, s, m, e }, ...store.get("t2s.history", []).filter(h => h.q !== q)].slice(0, 10));
  renderHistory();
}
function renderHistory(){
  const ul = $("history"); ul.innerHTML = "";
  const list = store.get("t2s.history", []);
  if (!list.length){ ul.innerHTML = '<li class="hint">Nenhuma pergunta ainda.</li>'; return; }
  list.forEach(h => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.type = "button"; b.textContent = (h.m ? `[${h.m.replace(/^sqlcoder:/, "")}] ` : "") + h.q; b.title = h.q + (h.m ? ` (gerado por ${h.m})` : "");
    // Ao reabrir uma pergunta, o SQL volta e é revalidado no banco.
    // O registro de avaliação da geração original continua valendo (h.e), sem duplicar.
    b.onclick = () => { $("q").value = h.q; sql = h.s; $("out").value = sql; evalId = evalGet(h.e) ? h.e : null; hideResults(); checkSQL(); };
    li.appendChild(b); ul.appendChild(li);
  });
}
async function copySQL(){
  sql = $("out").value.trim();
  if (!sql) return toast("Não há SQL para copiar.", "error");
  try{ await navigator.clipboard.writeText(sql); }
  catch{ const t = document.createElement("textarea"); t.value = sql; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast("SQL copiado.", "success");
}

/* ---------- inicialização ---------- */
// Configuração publicada pelo servidor: limite de linhas, modelo padrão e janela de contexto.
// Se o servidor não responder, a interface segue com os valores locais.
fetch("/api/config").then(r => r.json()).then(c => {
  if (c.maxRows) maxRows = c.maxRows;
  if (c.numCtx) numCtx = c.numCtx;
  if (c.descModel){ descModel = c.descModel; fillInterpModels(); }
  if (c.sampleRows) sampleRows = c.sampleRows;
  if (typeof c.maskSensitive === "boolean") maskSensitive = c.maskSensitive;
  if (c.sensitivePattern) try{ sensRe = new RegExp(c.sensitivePattern, "i"); }catch{}
  if (c.model){
    addModelOption(c.model); // OLLAMA_MODEL do .env aparece na lista mesmo se não for 7B/15B
    if (!store.get("t2s.model", "")) $("model").value = c.model; // só se o usuário não escolheu um
  }
}).catch(() => {});

// Garante que o modelo exista na lista de seleção (ex.: valor vindo do .env).
function addModelOption(m){
  if ([...$("model").options].some(o => o.value === m)) return;
  $("model").add(new Option(m, m));
}

// Repõe a última conexão (sem senha) para agilizar o uso diário.
const saved = store.get("t2s.conn", null);
if (saved) ["host", "port", "database", "user"].forEach(k => { if (saved[k]) $(k).value = saved[k]; });
// Repõe o modelo escolhido antes, se ele ainda estiver na lista (um nome antigo,
// como "sqlcoder:latest", é ignorado e vale o padrão).
const savedModel = store.get("t2s.model", "");
if ([...$("model").options].some(o => o.value === savedModel)) $("model").value = savedModel;
$("model").addEventListener("change", () => { store.set("t2s.model", $("model").value); fillInterpModels(); });

// Seletor "Modelo da interpretação": SQLCoder (o mesmo das perguntas, padrão)
// ou o modelo de uso geral DESC_MODEL como alternativa opcional.
let sampleRows = 20; // linhas da amostra (confirmado em /api/config)
function fillInterpModels(){
  const sel = $("interp-model"), v = sel.value || store.get("t2s.interpModel", SQLCODER);
  sel.innerHTML = `<option value="${SQLCODER}">SQLCoder (${esc($("model").value || "sqlcoder:7b")}, o mesmo das perguntas)</option>` +
    `<option value="${esc(descModel)}">${esc(descModel)} · alternativa de uso geral</option>`;
  sel.value = [...sel.options].some(o => o.value === v) ? v : SQLCODER;
}
fillInterpModels();
$("interp-model").addEventListener("change", () => store.set("t2s.interpModel", $("interp-model").value));

/* eventos da tela */
$("connect").onclick = connect;
$("password").addEventListener("keydown", e => { if (e.key === "Enter") connect(); });
$("tables").addEventListener("input", onContextInput);
$("tables").addEventListener("change", onContextInput);
$("tables").addEventListener("click", onContextClick);
$("none-tables").onclick = () => setAll(false);
$("ia-all").onclick = () => { if (!iaCtrl) askInterpret(); };
$("dlg-ia-cancel").onclick = () => $("dlg-ia").close();
$("dlg-ia-ok").onclick = () => { $("dlg-ia").close(); runInterpretation(); };
$("confirm-all").onclick = () => { const n = confirmAll(marked()); toast(`${n} interpretação(ões) confirmada(s).`, "success"); };
$("new-interp").onclick = () => setStep("sel");
$("to-review").onclick = () => setStep("rev");
$("ia-stop").onclick = () => iaCtrl && iaCtrl.abort();
$("ctx-export").onclick = exportContext;
$("ctx-import").onclick = () => $("ctx-file").click();
$("ctx-file").addEventListener("change", e => { const f = e.target.files[0]; if (f) importContext(f); e.target.value = ""; });
$("ex-add").onclick = addExampleManual;
$("save-ex").onclick = saveAsExample;
$("examples").addEventListener("click", e => {
  const b = e.target.closest("button[data-del]");
  if (!b) return;
  ctx.examples.splice(Number(b.dataset.del), 1);
  store.set(ctxKey, ctx); renderExamples();
});
$("all-tables").onclick = () => setAll(true);
$("project").addEventListener("input", () => { ctx.project = $("project").value; if (ctxKey) store.set(ctxKey, ctx); });
$("to-ask").onclick = () => show("ask");
document.querySelectorAll(".nav").forEach(n => n.onclick = () => show(n.dataset.view));
$("go").onclick = generate;
$("stop").onclick = () => controller && controller.abort();
$("copy").onclick = copySQL;
$("recheck").onclick = () => checkSQL();
$("exec").onclick = askExecute;
$("dlg-cancel").onclick = () => $("dlg").close();
$("dlg-ok").onclick = () => { $("dlg").close(); runQuery(); };
$("clear-hist").onclick = () => { store.set("t2s.history", []); renderHistory(); };
$("menu").onclick = () => setSide(document.body.classList.contains("side-closed"));
$("close-side").onclick = () => setSide(false);
$("overlay").onclick = () => setSide(false);
document.addEventListener("keydown", e => { if (e.key === "Escape" && innerWidth < 768) setSide(false); });
$("q").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate(); });
// Editar o SQL manualmente invalida a validação anterior: é preciso conferir de novo.
$("out").addEventListener("input", e => {
  sql = e.target.value; checked = null; updateExec(); $("check").textContent = "";
  const ev = evalGet(evalId); // a avaliação passa a registrar que o SQL foi editado
  if (ev && !ev.editado && sql.trim() !== ev.sql) evalPatch(evalId, { editado: true });
});
// Revisão semântica: painel após a execução e botões da tabela de avaliação.
$("review").addEventListener("click", e => { const b = e.target.closest("button[data-sem]"); if (b && evalId) setSem(evalId, b.dataset.sem); });
$("rev-note").addEventListener("change", e => evalPatch(evalId, { semNota: e.target.value.trim() }));
$("ev-table").addEventListener("click", e => {
  const b = e.target.closest("button[data-eid]");
  if (b) return setSem(b.dataset.eid, b.dataset.sem);
  const d = e.target.closest("button[data-evdel]");
  if (d && confirm("Remover este registro da avaliação?")){
    store.set(EVAL_KEY, evalAll().filter(r => r.id !== d.dataset.evdel));
    if (evalId === d.dataset.evdel){ evalId = null; renderReview(); }
    renderEval();
  }
});
$("ev-model").addEventListener("change", renderEval);
$("ev-cat").addEventListener("change", renderEval);
$("ev-export").onclick = exportEval;
$("ev-clear").onclick = () => {
  if (!evalAll().length || !confirm("Apagar TODOS os registros da avaliação? Exporte o CSV antes se precisar deles.")) return;
  store.set(EVAL_KEY, []); evalId = null; renderReview(); renderEval();
};
// Dica (tooltip) dos segmentos da barra de cada modelo.
$("ev-models").addEventListener("mousemove", e => {
  const s = e.target.closest("[data-tip]"), tip = $("tip");
  if (!s){ tip.hidden = true; return; }
  tip.textContent = s.dataset.tip; tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = (e.clientY + 14) + "px";
});
$("ev-models").addEventListener("mouseleave", () => $("tip").hidden = true);

setSide(innerWidth >= 768 ? store.get("t2s.side", true) : false);
renderHistory();
updateExec();
