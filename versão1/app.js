/* =============================================================================
 * Interface da ferramenta Text-to-SQL — Firebird 2.5 + SQLCoder via Ollama
 * -----------------------------------------------------------------------------
 * Como a tela funciona:
 *   Tela 1 (Conexão e contexto): conecta ao Firebird, mostra o esquema lido e
 *     permite descrever o significado de tabelas/colunas. Essas descrições
 *     entram no prompt enviado ao modelo — quanto melhor o contexto, melhor o SQL.
 *   Tela 2 (Perguntar): escreve a pergunta, gera o SQL (streaming do Ollama),
 *     valida no banco sem executar e, só depois da confirmação em um diálogo,
 *     executa e mostra os resultados limitados.
 *
 * O que fica no navegador (localStorage): conexão sem senha, modelo escolhido,
 * descrições de contexto e histórico das últimas perguntas. A senha NUNCA é
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
// Alterna entre a tela de conexão/contexto e a tela de perguntas.
function show(view){
  document.querySelectorAll(".view").forEach(v => v.hidden = v.id !== "view-" + view);
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
// Garante que exista um objeto de contexto para a tabela (cria se faltar).
// "skip" guarda as colunas desmarcadas (fica fora do prompt); contextos salvos
// antes desta opção não têm o campo e passam a ter todas as colunas marcadas.
const tctx = name => {
  const c = (ctx.tables[name] ??= { include: true, desc: "", cols: {} });
  c.skip ??= {};
  return c;
};

// Monta a lista de tabelas com campo de descrição para a tabela e para cada coluna.
// "abrir": nomes de tabelas a mostrar abertas (ex.: recém-interpretadas pela IA);
// as que já estavam abertas continuam abertas depois de redesenhar a lista.
function renderContext(abrir = new Set()){
  $("project").value = ctx.project || "";
  const abertas = new Set([...$("tables").querySelectorAll("details[open]")].map(d => d.dataset.t));
  $("tables").innerHTML = db.tables.map(t => {
    const c = tctx(t.name), n = esc(t.name);
    const cols = t.columns.map(col => `
      <div class="col-row">
        <label class="col-inc"><input type="checkbox" data-t="${n}" data-skip="${esc(col.name)}" ${c.skip[col.name] ? "" : "checked"} aria-label="Usar a coluna ${esc(col.name)}"><code>${esc(col.name)}</code></label>
        <small>${esc(col.type)}${col.pk ? " · chave primária" : ""}${col.fk ? " · referencia " + esc(col.fk) : ""} ${badge(t.name, col.name)}</small>
        <input type="text" data-t="${n}" data-c="${esc(col.name)}" placeholder="O que esta coluna significa?" value="${esc(c.cols[col.name] || "")}" aria-label="Significado de ${esc(col.name)}">
      </div>`).join("");
    return `<div class="tbl">
      <label class="inc"><input type="checkbox" data-t="${n}" data-k="include" ${c.include ? "checked" : ""}> usar</label>
      <details data-t="${n}" ${abertas.has(t.name) || abrir.has(t.name) ? "open" : ""}><summary>${n}<small>${t.columns.length} colunas</small></summary>
        <div class="tbl-body">
          <div class="col-bulk">Colunas: <button class="link" type="button" data-t="${n}" data-cols="1">marcar todas</button><button class="link" type="button" data-t="${n}" data-cols="0">desmarcar todas</button>
            · IA: <button class="link" type="button" data-t="${n}" data-ia="1">interpretar esta tabela</button><button class="link" type="button" data-t="${n}" data-acc="1">aceitar sugestões pendentes</button></div>
          <div class="desc-row"><input type="text" data-t="${n}" data-k="desc" placeholder="O que esta tabela representa?" value="${esc(c.desc)}" aria-label="Descrição de ${n}">${badge(t.name, TBL)}</div>
          ${cols}
        </div></details></div>`;
  }).join("");
  updateCount();
  updateIaStatus();
}
// Resumo do que vai para o prompt: tabelas marcadas e colunas marcadas nelas.
function updateCount(){
  const on = db.tables.filter(t => tctx(t.name).include);
  const cols = on.reduce((s, t) => s + t.columns.filter(col => !tctx(t.name).skip[col.name]).length, 0);
  $("ctx-count").textContent = `${on.length} de ${db.tables.length} tabela(s) marcada(s) · ${cols} coluna(s) disponíveis para o modelo.`;
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
// Links "marcar todas"/"desmarcar todas" dentro de cada tabela.
function onContextClick(e){
  const ok = e.target.closest("button[data-ok]");
  if (ok){ // aceitar uma sugestão da IA sem editar
    tctx(ok.dataset.bt).src[ok.dataset.bk] = "ok";
    store.set(ctxKey, ctx); updateBadge(ok.dataset.bt, ok.dataset.bk); updateIaStatus();
    return;
  }
  const ia = e.target.closest("button[data-ia]");
  if (ia){ if (!iaCtrl) interpret(db.tables.filter(t => t.name === ia.dataset.t)); return; }
  const acc = e.target.closest("button[data-acc]");
  if (acc){ // aceitar todas as sugestões pendentes da tabela
    const c = tctx(acc.dataset.t);
    Object.keys(c.src || {}).forEach(k => { if (c.src[k] === "ia"){ c.src[k] = "ok"; updateBadge(acc.dataset.t, k); } });
    store.set(ctxKey, ctx); updateIaStatus();
    return;
  }
  const b = e.target.closest("button[data-cols]");
  if (!b) return;
  setCols(b.closest(".tbl"), b.dataset.t, b.dataset.cols === "1");
  store.set(ctxKey, ctx); updateCount();
}
// Salva cada alteração de descrição no localStorage (uma por uma, sem botão salvar).
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
  else if (el.dataset.k === "desc" || el.dataset.c){
    const k = el.dataset.c || TBL;
    if (el.dataset.c) c.cols[k] = el.value; else c.desc = el.value;
    // Editar uma sugestão da IA marca como "editada"; apagar o texto limpa a origem.
    if (!el.value.trim()){ if (c.src) delete c.src[k]; if (c.conf) delete c.conf[k]; }
    else if (srcOf(c, k) === "ia" || srcOf(c, k) === "ok") c.src[k] = "edit";
    if (e.type === "change"){ updateBadge(t, k); updateIaStatus(); } // atualiza a marca ao sair do campo
  }
  store.set(ctxKey, ctx);
  updateCount();
}

/* ---------- interpretação do esquema pela IA (descrições sugeridas) ---------- */
// Fluxo: para cada tabela, o servidor lê uma amostra de valores (só leitura) e
// um modelo de uso geral (DESC_MODEL, ex.: gemma4:e4b) escreve a descrição da
// tabela e de cada coluna, com um grau de confiança. As sugestões preenchem só
// campos VAZIOS (ou que ainda tenham sugestão não revisada da IA): o que a
// pessoa escreveu nunca é sobrescrito. Cada descrição guarda a sua origem:
//   src[chave] = "ia"   -> sugerida pela IA, aguardando revisão
//                "ok"   -> sugerida pela IA e aceita sem edição
//                "edit" -> sugerida pela IA e editada pela pessoa
//                (sem src) -> escrita pela pessoa
// A chave da descrição da tabela é TBL; a das colunas é o nome da coluna.
// Decisão do autor: todas as descrições (revisadas ou não) vão para o SQLCoder.
const TBL = "@tabela";
let descModel = "gemma4:e4b"; // confirmado em /api/config
let iaCtrl = null;           // AbortController da interpretação em andamento
const srcOf = (c, k) => (c.src ||= {})[k];
const CONF = { alta: "alta", media: "média", "média": "média", baixa: "baixa" };

// Marca exibida ao lado de cada descrição. Pendente = botão "aceitar".
function badge(t, k){
  const c = tctx(t), s = srcOf(c, k), conf = CONF[(c.conf || {})[k]] || "";
  const at = `data-bt="${esc(t)}" data-bk="${esc(k)}"`;
  if (s === "ia") return `<button type="button" class="ia pend" ${at} data-ok="1" title="Sugestão da IA${conf ? " (confiança " + conf + ")" : ""}. Clique para aceitar sem editar, ou edite o texto.">IA${conf ? " · " + conf : ""} · revisar</button>`;
  if (s === "ok") return `<span class="ia ok" ${at} title="Sugestão da IA aceita">IA ✓</span>`;
  if (s === "edit") return `<span class="ia ok" ${at} title="Sugestão da IA editada por você">IA ✓ editada</span>`;
  return `<span class="ia" ${at} hidden></span>`;
}
function updateBadge(t, k){
  for (const el of $("tables").querySelectorAll(".ia"))
    if (el.dataset.bt === t && el.dataset.bk === k){ el.outerHTML = badge(t, k); break; }
}
// Resumo da origem das descrições (útil para a avaliação do TCC).
function updateIaStatus(){
  if (!db) return;
  const n = { ia: 0, ok: 0, edit: 0, manual: 0 };
  db.tables.forEach(t => {
    const c = tctx(t.name);
    [[TBL, c.desc], ...t.columns.map(col => [col.name, c.cols[col.name]])].forEach(([k, v]) => {
      if (!(v || "").trim()) return;
      n[srcOf(c, k) || "manual"]++;
    });
  });
  $("ia-summary").textContent = `Descrições: ${n.ia} da IA aguardando revisão · ${n.ok} aceitas · ${n.edit} editadas · ${n.manual} escritas por você.`;
}

// Prompt para o modelo de descrição: estrutura, relacionamentos e amostra.
function descPrompt(t, amostra){
  const c = tctx(t.name);
  const rel = [
    ...t.columns.filter(col => col.fk).map(col => `${t.name}.${col.name} referencia ${col.fk}`),
    ...db.tables.flatMap(o => o.columns.filter(col => col.fk && col.fk.startsWith(t.name + "(")).map(col => `${o.name}.${col.name} referencia ${col.fk}`))
  ];
  const linhas = t.columns.map(col => {
    const s = amostra.columns[col.name] || {};
    const vals = s.omitted ? `valores não lidos (${s.omitted})`
      : s.values && s.values.length ? "exemplos: " + s.values.map(v => JSON.stringify(v)).join(", ") + (s.nulls ? ` (+${s.nulls} vazios)` : "")
      : "sem valores na amostra";
    const atual = (c.cols[col.name] || "").trim() && srcOf(c, col.name) !== "ia" ? ` | já descrita pelo usuário: "${oneLine(c.cols[col.name])}"` : "";
    return `- ${col.name} ${col.type}${col.pk ? " CHAVE PRIMÁRIA" : ""} | ${vals}${atual}`;
  });
  const descAtual = c.desc.trim() && srcOf(c, TBL) !== "ia" ? `\nDescrição da tabela escrita pelo usuário: "${oneLine(c.desc)}"` : "";
  return `Você é um analista de dados. Explique em português do Brasil o que representa a tabela ${t.name} de um banco Firebird e o que significa cada coluna.
Contexto do sistema: ${oneLine(ctx.project || "") || "não informado"}${descAtual}
Relacionamentos: ${rel.length ? rel.join("; ") : "nenhum declarado"}
Colunas (nome, tipo e valores de uma amostra de ${amostra.rows} linha(s)):
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

// Interpreta UMA tabela: amostra -> IA -> aplica sugestões. Devolve quantas aplicou.
async function interpretTable(t, signal){
  const amostra = await post("/api/sample", { table: t.name });
  const res = await fetch("/ollama/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ model: descModel, prompt: descPrompt(t, amostra), stream: false, format: "json",
      options: { temperature: 0, num_predict: 4096 } })
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 404
    ? `Modelo "${descModel}" não encontrado no Ollama. Instale com "ollama pull ${descModel}" ou ajuste DESC_MODEL no .env.`
    : d.error || "Erro " + res.status);
  let j;
  try{ j = JSON.parse(d.response); }catch{ throw new Error("a IA não devolveu um JSON válido"); }
  const c = tctx(t.name); c.src ||= {}; c.conf ||= {};
  const pode = (k, atual) => !(atual || "").trim() || c.src[k] === "ia"; // nunca sobrescreve texto da pessoa
  const conf = v => CONF[norm(v)] ? norm(v).replace("média", "media") : "";
  let n = 0;
  const td = j && j.tabela && typeof j.tabela.descricao === "string" ? j.tabela.descricao.trim() : "";
  if (td && pode(TBL, c.desc)){ c.desc = td; c.src[TBL] = "ia"; c.conf[TBL] = conf(j.tabela.confianca); n++; }
  const cols = new Map(Object.entries((j && j.colunas) || {}).map(([k, v]) => [k.toUpperCase(), v]));
  for (const col of t.columns){
    const s = cols.get(col.name.toUpperCase());
    const txt = s && typeof s.descricao === "string" ? s.descricao.trim() : "";
    if (txt && pode(col.name, c.cols[col.name])){ c.cols[col.name] = txt; c.src[col.name] = "ia"; c.conf[col.name] = conf(s.confianca); n++; }
  }
  store.set(ctxKey, ctx);
  return n;
}

// Interpreta uma lista de tabelas, uma por vez, mostrando o progresso.
async function interpret(tables){
  if (!tables.length) return toast("Marque ao menos uma tabela para interpretar.", "error");
  iaCtrl = new AbortController();
  $("ia-all").disabled = true; $("ia-stop").hidden = false;
  const st = $("ia-status"), falhas = [], abrir = new Set();
  let total = 0, feitas = 0;
  try{
    for (const t of tables){
      st.textContent = `Interpretando ${feitas + 1} de ${tables.length}: ${t.name} (com ${descModel})…`;
      try{ const n = await interpretTable(t, iaCtrl.signal); total += n; if (n) abrir.add(t.name); }
      catch(err){
        if (err.name === "AbortError") throw err;
        falhas.push(`${t.name}: ${explain(err)}`);
        if (/não encontrado no Ollama|Ollama indisponível|Nenhum banco/.test(err.message)) break; // não adianta seguir
      }
      feitas++;
      renderContext(abrir);
    }
    st.textContent = `Concluído: ${total} sugestão(ões) em ${feitas} tabela(s). Revise as marcadas com "IA · revisar".` +
      (falhas.length ? ` Falhas: ${falhas.join(" | ")}` : "");
    if (falhas.length) toast("Algumas tabelas não foram interpretadas.", "error");
  }catch(err){
    st.textContent = err.name === "AbortError" ? `Interrompido. ${total} sugestão(ões) aplicadas em ${feitas} tabela(s).` : explain(err);
  }finally{
    renderContext(abrir);
    $("ia-all").disabled = false; $("ia-stop").hidden = true; iaCtrl = null;
  }
}

/* ---------- exportar / importar o contexto (JSON) ---------- */
// O contexto (descrições, origens, seleção de tabelas/colunas e exemplos) fica
// no navegador; o arquivo serve de backup e para repetir testes com o mesmo
// contexto na avaliação. Importar SUBSTITUI o contexto do banco conectado.
function exportContext(){
  const dados = { formato: "t2s-contexto", versao: 1, banco: ctxKey.replace(/^t2s\.ctx\./, ""), exportadoEm: new Date().toISOString(), contexto: ctx };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(dados, null, 2)], { type: "application/json" }));
  const base = (ctxKey.split(/[\\/]/).pop() || "banco").replace(/\.fdb$/i, "").replace(/[^\w-]+/g, "_");
  a.download = `contexto-${base}-${new Date().toISOString().slice(0, 10)}.json`;
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
    } else if (!sql){
      // Nenhum SQL aproveitável: mostra o que o modelo devolveu para diagnóstico.
      // JSON.stringify deixa visíveis espaços e quebras de linha soltos.
      const bruto = raw ? JSON.stringify(raw.slice(0, 300)) : "(vazia)";
      $("check").className = "bad";
      $("check").textContent = `! O modelo encerrou sem escrever SQL. No SQLCoder, isso costuma indicar que ele não achou no esquema enviado o que a pergunta pede: confira as tabelas enviadas e as descrições, ou reformule a pergunta. Resposta bruta: ${bruto}` +
        ` · motivo de parada: ${doneReason || "?"} · tokens gerados: ${fim?.eval_count ?? "?"} · tokens do prompt processados: ${fim?.prompt_eval_count ?? "?"}`;
    } else if (/i do not know/i.test(sql)){
      // O modelo declarou que o esquema enviado não basta para responder.
      $("check").className = "bad";
      $("check").textContent = "! O modelo indicou que não consegue responder com as tabelas/colunas marcadas. Marque as que a pergunta precisa, descreva-as melhor ou reformule a pergunta.";
      sql = ""; updateExec();
    } else if (sql){ saveHistory(question, sql, model); checkSQL(aviso); } // valida automaticamente ao terminar (mantendo o aviso de prompt grande, se houver)
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
    el.className = r.note ? "" : "ok";
    el.textContent = (r.note ? "! " + r.note : "✓ O banco aceitou esta consulta (nada foi executado).") + (aviso ? "\n! " + aviso : "");
  }catch(err){
    checked = null; updateExec();
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
  }catch(err){
    $("res-note").className = "bad";
    $("res-note").textContent = "✕ Falha na execução: " + explain(err);
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
function hideResults(){ $("res-card").hidden = true; $("res-note").textContent = ""; $("res-table").innerHTML = ""; $("res-meta").textContent = ""; }

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

/* ---------- histórico e cópia ---------- */
// Guarda as 10 últimas perguntas no navegador (sem dados do banco), com o
// modelo que gerou cada SQL — útil para comparar 7B e 15B na avaliação.
function saveHistory(q, s, m){
  store.set("t2s.history", [{ q, s, m }, ...store.get("t2s.history", []).filter(h => h.q !== q)].slice(0, 10));
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
    b.onclick = () => { $("q").value = h.q; sql = h.s; $("out").value = sql; hideResults(); checkSQL(); };
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
  if (c.descModel) descModel = c.descModel;
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
$("model").addEventListener("change", () => store.set("t2s.model", $("model").value));

/* eventos da tela */
$("connect").onclick = connect;
$("password").addEventListener("keydown", e => { if (e.key === "Enter") connect(); });
$("tables").addEventListener("input", onContextInput);
$("tables").addEventListener("change", onContextInput);
$("tables").addEventListener("click", onContextClick);
$("none-tables").onclick = () => setAll(false);
$("ia-all").onclick = () => { if (!iaCtrl) interpret(marked()); };
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
$("out").addEventListener("input", e => { sql = e.target.value; checked = null; updateExec(); $("check").textContent = ""; });

setSide(innerWidth >= 768 ? store.get("t2s.side", true) : false);
renderHistory();
updateExec();
