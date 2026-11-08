/* =============================================================================
 * Servidor da ferramenta Text-to-SQL — Firebird 2.5 + SQLCoder via Ollama
 * -----------------------------------------------------------------------------
 * Papel deste arquivo (a "API" da arquitetura do projeto):
 *   1. Servir a interface (index.html, styles.css, app.js).
 *   2. Conectar no Firebird informado na tela e ler o esquema (tabelas, colunas
 *      e chaves) que servirá de contexto para o modelo.
 *   3. Fazer proxy das chamadas ao Ollama (evita bloqueio de CORS no navegador).
 *   4. Validar e executar consultas com camadas de proteção (veja abaixo).
 *
 * Segurança: o SQL gerado pelo modelo é tratado como ENTRADA NÃO CONFIÁVEL.
 * São três camadas independentes — o SQL só chega ao banco se passar por todas:
 *   a) Verificação no servidor (assertReadable): aceita apenas UMA instrução
 *      começando com SELECT ou WITH, depois de remover comentários e neutralizar
 *      strings. Não é um parser SQL completo; é a primeira barreira.
 *   b) Transação READ ONLY: toda consulta roda em transação de somente leitura;
 *      o próprio Firebird recusa qualquer comando de escrita. É a garantia real.
 *   c) Limite de linhas: a execução devolve no máximo MAX_ROWS linhas.
 *
 * Uso individual: o servidor escuta apenas em 127.0.0.1 e guarda a conexão
 * informada na tela somente na memória — nenhuma credencial é gravada em disco.
 * ========================================================================== */

const http = require("http"), fs = require("fs"), path = require("path");
const { Readable, Transform, pipeline } = require("stream");

// Carrega o arquivo .env da pasta deste arquivo (recurso do Node >= 20.12),
// independentemente da pasta de onde o servidor foi iniciado. Se o arquivo
// não existir, o servidor simplesmente segue com os valores padrão abaixo.
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

/* ---------- configuração externa (mude sem precisar tocar no código) ---------- */
const PORT = Number(process.env.PORT) || 3000;                          // porta da ferramenta
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434"; // endereço do Ollama
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "sqlcoder:7b";        // modelo sugerido na interface
const MAX_ROWS = Math.max(1, Number(process.env.MAX_ROWS) || 200);      // linhas devolvidas por execução
// Janela de contexto do modelo (tokens). O que passar disso é DESCARTADO pelo
// Ollama sem aviso; o prompt chega pela metade e o modelo inventa nomes ou entra
// em loop. Valores maiores usam mais memória e deixam a geração mais lenta.
const OLLAMA_NUM_CTX = Math.max(512, Number(process.env.OLLAMA_NUM_CTX) || 8192);
// Interpretação do esquema pela IA (descrições sugeridas para revisão humana).
const DESC_MODEL = process.env.DESC_MODEL || "gemma4:e4b";                  // modelo de uso geral que escreve as descrições
const SAMPLE_ROWS = Math.min(200, Math.max(1, Number(process.env.SAMPLE_ROWS) || 20)); // linhas lidas por tabela
const MASK_SENSITIVE = String(process.env.DESC_MASK_SENSITIVE ?? "true").toLowerCase() !== "false"; // não ler CPF, e-mail, telefone...
// Diagnóstico (opcional, desligado por padrão): grava a ÚLTIMA geração de cada
// modelo (prompt enviado + resposta bruta do Ollama) em versão1/debug/. Serve
// para investigar respostas vazias ou estranhas. Contém o esquema e a pergunta:
// use só com banco de teste e desligue depois (AGENTS.md: minimizar logs de prompts).
const DEBUG_PROMPT = String(process.env.DEBUG_PROMPT || "").toLowerCase() === "true";

const STATIC = { "/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css", "/app.js": "app.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

// Opções da conexão Firebird (preenchidas no /api/connect). Fica só na memória.
let fbOpts = null;
// Esquema da conexão atual: usado para validar os pedidos de amostra.
let fbSchema = null;

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => { let b = ""; req.on("data", c => b += c); req.on("end", () => ok(b)); });

/* =============================================================================
 * CAMADA 1 — verificação da consulta antes de qualquer contato com o banco
 * ========================================================================== */

// Prepara o SQL para análise: remove comentários e troca cada literal de string
// por ''. Assim, um ";" ou a palavra "DROP" dentro de um texto entre aspas não
// confunde a checagem (ex.: WHERE nome = 'DROP TABLE' é inofensivo).
function stripForCheck(sql) {
  return String(sql || "")
    .replace(/--[^\n]*/g, " ")          // comentários de linha
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // comentários de bloco
    .replace(/'(?:[^']|'')*'/g, "''");  // strings do Firebird ('' é aspa escapada)
}

// Aceita apenas UMA instrução de leitura: SELECT, ou WITH ... SELECT (CTE).
// Importante: isto NÃO é um parser SQL completo. É a primeira barreira; a
// garantia forte de somente leitura vem da transação READ ONLY (camada 2) e do
// usuário do banco ter privilégio apenas de SELECT (configuração recomendada).
function assertReadable(sql) {
  const q = String(sql || "").trim().replace(/;+\s*$/, ""); // ignora o ; final
  // O .trim() depois de stripForCheck importa: um comentário no início da
  // consulta deixa um "\n" para trás e a consulta começaria com espaço em branco.
  const clean = stripForCheck(q).trim();
  if (!clean.trim()) throw new Error("Consulta vazia.");
  if (!/^(select|with)\b/i.test(clean))
    throw new Error("Somente consultas de leitura (SELECT ou WITH ... SELECT) são permitidas.");
  if (clean.includes(";"))
    throw new Error("Envie uma única instrução por vez (ponto e vírgula extra detectado).");
  // Comandos que alteram dados, estrutura ou permissões — bloqueados por nome.
  // Mesmo se algo escapasse daqui, a transação READ ONLY faria o banco recusar.
  const bad = clean.match(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|recreate|execute|exec|call|copy|declare|set\s+term)\b/i);
  if (bad) throw new Error(`Comando não permitido detectado: ${bad[1].toUpperCase()}.`);
  if (/\binto\b/i.test(clean)) throw new Error("SELECT INTO não é permitido.");            // cria tabela a partir de SELECT
  if (/\bfor\s+update\b/i.test(clean)) throw new Error("SELECT FOR UPDATE não é permitido."); // trava registros
  return q;
}

/* =============================================================================
 * Acesso ao Firebird
 * ========================================================================== */

// Cada operação abre uma conexão nova, roda dentro de uma transação READ ONLY
// (camada 2 de segurança: o banco recusa escrita) e fecha em seguida. O rollback
// no final é proposital: leitura não precisa de commit e nada fica pendente.
function fbRun(fn) {
  const fb = require("node-firebird"); // dependência carregada aqui para o erro ser claro quando o Firebird for usado
  return new Promise((ok, no) => {
    fb.attach(fbOpts, (err, db) => {
      if (err) return no(err);
      const end = (e, r) => db.detach(() => e ? no(e) : ok(r)); // sempre desconecta, com ou sem erro
      db.transaction(fb.ISOLATION_READ_COMMITED_READ_ONLY, (e, tr) => {
        if (e) return end(e);
        fn(tr).then(r => tr.rollback(() => end(null, r)), er => tr.rollback(() => end(er)));
      });
    });
  });
}
const fbQuery = (tr, sql) => new Promise((ok, no) => tr.query(sql, [], (e, r) => e ? no(e) : ok(r)));

// O driver às vezes devolve AggregateError sem texto (ex.: servidor desligado);
// esta função extrai o motivo real da sub-lista de erros.
function fbErrMsg(err) {
  if (!err) return "erro desconhecido";
  if (err.message) return err.message;
  if (Array.isArray(err.errors) && err.errors[0]) return fbErrMsg(err.errors[0]);
  return err.code || "verifique servidor, porta, caminho do banco, usuário e senha";
}

// Traduz erros típicos do Firebird 2.5 em dicas acionáveis. O SQLCoder aprendeu
// com vários bancos e costuma usar sintaxe de PostgreSQL/MySQL/SQLite; a dica
// aponta o ajuste que a pessoa pode fazer na caixa de SQL antes de conferir de novo.
function fbFriendly(err, q) {
  const raw = fbErrMsg(err);
  const m = raw.match(/Token unknown[^-]*-\s*line (\d+), column (\d+),\s*(.+)$/i);
  let dica = null;
  if (m) {
    const linha = Number(m[1]), coluna = Number(m[2]);
    const token = m[3].trim();
    // Embrulho usado na validação/execução: a consulta ocupa as linhas 2..N+1,
    // então o parêntese de fechamento do embrulho cai na linha N+2. Quando o
    // Firebird reclama justamente desse parêntese, o problema está ANTES dele.
    const linhaFecha = String(q).split("\n").length + 2;
    const T = token.toUpperCase();
    // Alguns erros apontam para o token SEGUINTE (ex.: LIMIT aponta para o número
    // que vem depois). Nesses casos, olhamos a palavra imediatamente anterior à
    // posição indicada, já convertida para a consulta original (linha 1 do
    // embrulho é o "SELECT * FROM (", então a consulta começa na linha 2).
    const linhasQ = String(q).split("\n");
    const antes = (linhasQ[linha - 2] || "").slice(0, Math.max(0, coluna - 1));
    const palavra = ((antes.match(/([A-Za-z_]+)\s*$/) || [])[1] || "").toUpperCase();
    const limpa = stripForCheck(q);
    const abre = (limpa.match(/\(/g) || []).length;
    const fecha = (limpa.match(/\)/g) || []).length;
    // Final "pendurado": termina em ponto, vírgula, operador ou palavra que exige
    // continuação — sinal de que a geração foi cortada no meio.
    const fim = limpa.trim().match(/(\.|,|=|<|>|\(|\b(?:select|from|where|and|or|not|on|join|by|having|in|like|between|as|distinct|first|skip|case|when|then|else))\s*$/i);
    const temBool = /\b(true|false)\b/i.test(limpa);
    const boolDica = "O Firebird 2.5 não tem tipo booleano: o modelo escreveu TRUE ou FALSE. Compare a coluna de flag com o valor real dela (ex.: 1, 0, 'S', 'N' — veja a descrição da coluna).";
    if (token === ")" && linha === linhaFecha && fecha > abre)
      dica = "Há um parêntese ')' sobrando no final da consulta. Remova-o e confira de novo.";
    else if (token === ")" && linha === linhaFecha && (fim || abre > fecha))
      dica = `A consulta parece incompleta (${fim ? `termina em "${fim[1]}"` : "tem parêntese '(' sem fechar"}). A geração pode ter sido cortada ou o modelo entrou em loop: complete o SQL na caixa ou gere de novo com menos tabelas marcadas.`;
    else if (token === ")" && linha === linhaFecha && temBool)
      dica = boolDica;
    else if (token === ")" && linha === linhaFecha)
      dica = "O Firebird não entendeu o final da consulta. Verifique se ela está completa e se não usa sintaxe de outros bancos (ex.: TRUE/FALSE, IS TRUE, NULLS LAST).";
    else if (T === "ILIKE" || palavra === "ILIKE")
      dica = "O Firebird 2.5 não tem ILIKE. Use UPPER(coluna) LIKE UPPER('%valor%') ou coluna CONTAINING 'valor'.";
    else if (T === "LIMIT" || palavra === "LIMIT")
      dica = "O Firebird 2.5 não usa LIMIT. Use SELECT FIRST n no início da consulta.";
    else if (T === "OFFSET" || T === "FETCH" || palavra === "OFFSET" || palavra === "FETCH")
      dica = "O Firebird 2.5 não usa OFFSET/FETCH (sintaxe do Firebird 3+). Use SELECT FIRST n SKIP m.";
    else if (T === "OVER" || palavra === "OVER")
      dica = "O Firebird 2.5 não tem funções de janela (OVER/PARTITION BY). Reformule com GROUP BY ou subconsultas.";
    else if (T === ":" || T === "::")
      dica = "O Firebird 2.5 não tem conversão com :: (sintaxe do PostgreSQL). Use CAST(valor AS tipo).";
    else if (temBool)
      dica = boolDica;
  } else if (/=-?\s*20[46]/.test(raw.replace(/\s/g, ""))) {
    // -204 = tabela inexistente; -206 = coluna inexistente (alucinação do modelo).
    dica = "Provável erro do modelo: objeto citado não existe no banco. Revise o SQL na caixa e corrija o nome citado.";
  }
  return dica ? `${dica} (detalhe: ${raw})` : raw;
}

/* ---------- leitura do esquema (contexto para o modelo) ---------- */
// Mapa de tipos internos do Firebird para nomes legíveis.
const FB_TYPES = { 7: "SMALLINT", 8: "INTEGER", 10: "FLOAT", 12: "DATE", 13: "TIME", 14: "CHAR", 16: "BIGINT", 27: "DOUBLE PRECISION", 35: "TIMESTAMP", 37: "VARCHAR", 261: "BLOB" };
// Converte a linha de metadados em um tipo escrito (com tamanho/precisão).
function fbType(r) {
  const base = FB_TYPES[r.FT] || "UNKNOWN";
  if ([7, 8, 16].includes(r.FT) && (r.SC < 0 || r.ST > 0)) return `${r.ST === 2 ? "DECIMAL" : "NUMERIC"}(${r.PR || 18},${-r.SC})`;
  if ((r.FT === 14 || r.FT === 37) && r.CL) return `${base}(${r.CL})`;
  if (r.FT === 261) return r.ST === 1 ? "BLOB SUB_TYPE TEXT" : "BLOB";
  return base;
}

// Lê tabelas, colunas, chaves primárias (PK) e estrangeiras (FK) do banco.
// Só tabelas reais: filtra views (RDB$VIEW_BLR IS NULL) e objetos de sistema.
async function readFbSchema(tr) {
  const cols = await fbQuery(tr, `
    SELECT TRIM(rf.RDB$RELATION_NAME) AS T, TRIM(rf.RDB$FIELD_NAME) AS N,
           f.RDB$FIELD_TYPE AS FT, f.RDB$FIELD_SUB_TYPE AS ST, f.RDB$FIELD_SCALE AS SC,
           f.RDB$FIELD_PRECISION AS PR, f.RDB$CHARACTER_LENGTH AS CL
    FROM RDB$RELATION_FIELDS rf
    JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
    JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = rf.RDB$RELATION_NAME
    WHERE COALESCE(r.RDB$SYSTEM_FLAG, 0) = 0 AND r.RDB$VIEW_BLR IS NULL
    ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION`);
  const keys = await fbQuery(tr, `
    SELECT TRIM(rc.RDB$RELATION_NAME) AS T, TRIM(sg.RDB$FIELD_NAME) AS N, TRIM(rc.RDB$CONSTRAINT_TYPE) AS K,
           TRIM(r2.RDB$RELATION_NAME) AS RT, TRIM(sg2.RDB$FIELD_NAME) AS RC
    FROM RDB$RELATION_CONSTRAINTS rc
    JOIN RDB$INDEX_SEGMENTS sg ON sg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
    LEFT JOIN RDB$REF_CONSTRAINTS refc ON refc.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
    LEFT JOIN RDB$RELATION_CONSTRAINTS r2 ON r2.RDB$CONSTRAINT_NAME = refc.RDB$CONST_NAME_UQ
    LEFT JOIN RDB$INDEX_SEGMENTS sg2 ON sg2.RDB$INDEX_NAME = r2.RDB$INDEX_NAME AND sg2.RDB$FIELD_POSITION = sg.RDB$FIELD_POSITION
    WHERE rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY')`);

  // Junta tudo em: { tables: [{ name, columns: [{ name, type, pk?, fk? }] }] }
  const tables = new Map();
  for (const r of cols) {
    if (!tables.has(r.T)) tables.set(r.T, { name: r.T, columns: [] });
    tables.get(r.T).columns.push({ name: r.N, type: fbType(r) });
  }
  for (const k of keys) {
    const col = tables.get(k.T)?.columns.find(x => x.name === k.N);
    if (!col) continue;
    if (k.K === "PRIMARY KEY") col.pk = true;
    else if (k.RT) col.fk = `${k.RT}(${k.RC})`;
  }
  return { tables: [...tables.values()] };
}

/* ---------- conexão ---------- */
// Monta as opções a partir do formulário e testa a conexão lendo o esquema.
// A conexão anterior só é substituída se a leitura do esquema der certo.
async function connectFirebird(cfg) {
  const prev = fbOpts;
  fbOpts = {
    host: cfg.host, port: Number(cfg.port) || 3050, database: cfg.database,
    user: cfg.user, password: cfg.password, lowercase_keys: false // mantém os nomes como estão no banco
  };
  try {
    fbSchema = await fbRun(readFbSchema);
    return fbSchema;
  } catch (err) {
    fbOpts = prev; // falhou: mantém a conexão anterior (se havia uma)
    throw new Error("Não foi possível conectar ao Firebird: " + fbErrMsg(err));
  }
}

/* =============================================================================
 * CAMADA 2/3 aplicadas — validação e execução
 * ========================================================================== */

/* ---------- validação sem execução ---------- */
// O Firebird 2.5 não tem EXPLAIN. O truque: a consulta é colocada dentro de um
// subselect com WHERE 1 = 0. O servidor precisa compilar a consulta inteira
// (confere sintaxe, tabelas e colunas), mas nenhuma linha é lida e nada muda.
// Consultas com WITH não cabem dentro de um subselect nessa versão; elas ficam
// sem essa conferência e a resposta avisa para revisar com atenção.
async function validateFb(sql) {
  const q = assertReadable(sql); // camada 1
  if (!fbOpts) throw new Error("Nenhum banco conectado. Conecte um Firebird primeiro.");
  if (/^with\b/i.test(stripForCheck(q)))
    return { ok: true, note: "Consultas com WITH não são conferidas no Firebird 2.5. Revise com atenção antes de executar." };
  try {
    await fbRun(tr => fbQuery(tr, `SELECT * FROM (\n${q}\n) t WHERE 1 = 0`));
  } catch (err) {
    throw new Error(fbFriendly(err, q)); // erro traduzido: a pessoa pode corrigir o SQL e conferir de novo
  }
  return { ok: true };
}

// Converte valores para algo serializável em JSON e legível na tabela.
// DECIMAL/NUMERIC pode chegar como string do driver — mantemos como veio.
function cleanValue(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return "[binário]";
  if (v instanceof Date) {
    // Formata no fuso local para não deslocar a data (evita o shift de UTC).
    const p = n => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  const t = typeof v;
  if (t === "string" || t === "number") return v;
  return "[objeto]"; // BLOB e tipos não reconhecidos aparecem como marcador
}

/* ---------- execução com resultados ---------- */
// Executa a consulta JÁ VALIDADA e CONFIRMADA pelo usuário e devolve no máximo
// MAX_ROWS linhas. Busca-se MAX_ROWS + 1 apenas para saber se houve truncamento.
// - Consultas normais são embrulhadas em SELECT FIRST n (camada 3): o Firebird
//   devolve poucas linhas mesmo se a consulta casasse com milhões.
// - Consultas com WITH não podem ser embrulhadas no Firebird 2.5; nelas, o
//   limite é aplicado depois, aqui no servidor (limitação documentada no README).
//   A transação READ ONLY continua garantindo a somente leitura.
async function executeFb(sql) {
  const q = assertReadable(sql); // camada 1
  if (!fbOpts) throw new Error("Nenhum banco conectado. Conecte um Firebird primeiro.");
  const limit = MAX_ROWS + 1;
  const t0 = Date.now();
  const data = /^with\b/i.test(stripForCheck(q))
    ? await fbRun(tr => fbQuery(tr, q))
    : await fbRun(tr => fbQuery(tr, `SELECT FIRST ${limit} * FROM (\n${q}\n) t`))
      .catch(err => { throw new Error(fbFriendly(err, q)); }); // erro traduzido também na execução

  const rows = data.slice(0, MAX_ROWS).map(r => {
    const o = {};
    for (const k of Object.keys(r)) o[k] = cleanValue(r[k]);
    return o;
  });
  return {
    columns: rows.length ? Object.keys(rows[0]) : [], // nomes das colunas na ordem do banco
    rows,
    rowCount: rows.length,
    truncated: data.length > MAX_ROWS, // veio MAX_ROWS+1 => resultado foi cortado
    elapsedMs: Date.now() - t0
  };
}

/* =============================================================================
 * Amostra de valores para a interpretação do esquema pela IA
 * ========================================================================== */
// A IA de descrição entende muito melhor uma coluna vendo valores reais
// (ex.: CLIENTE só tem 'S'/'N'; COD_TIPOPGTO vai de 1 a 4). Aqui lemos as
// primeiras SAMPLE_ROWS linhas de UMA tabela, em transação READ ONLY, e
// devolvemos até 8 valores distintos por coluna (textos cortados em 40
// caracteres). Nada é gravado; os valores vão só para o Ollama local.
// Segurança: o nome da tabela vem do pedido, mas só é aceito se existir no
// esquema lido na conexão; os identificadores vão entre aspas duplas, com
// aspas internas duplicadas — o SQL nunca é montado com texto livre do usuário.
// Colunas BLOB não são lidas. Com DESC_MASK_SENSITIVE=true (padrão), colunas
// cujo nome indica dado pessoal (CPF, e-mail, telefone, senha...) também não.
const SENSIVEL = /(CPF|CNPJ|^RG$|^RG_|_RG$|EMAIL|E_MAIL|FONE|CELULAR|SENHA|PASSWORD|TOKEN)/i;
const qid = n => '"' + String(n).replace(/"/g, '""') + '"';
async function sampleTable(name) {
  if (!fbOpts || !fbSchema) throw new Error("Nenhum banco conectado. Conecte um Firebird primeiro.");
  const t = fbSchema.tables.find(x => x.name === name);
  if (!t) throw new Error("Tabela não encontrada no esquema lido do banco.");
  const omitida = c => c.type.startsWith("BLOB") ? "binário" : (MASK_SENSITIVE && SENSIVEL.test(c.name)) ? "dado sensível" : null;
  const ler = t.columns.filter(c => !omitida(c));
  const rows = ler.length
    ? await fbRun(tr => fbQuery(tr, `SELECT FIRST ${SAMPLE_ROWS} ${ler.map(c => qid(c.name)).join(", ")} FROM ${qid(t.name)}`))
        .catch(err => { throw new Error("Não foi possível ler a amostra: " + fbErrMsg(err)); })
    : [];
  const columns = {};
  for (const c of t.columns) {
    const om = omitida(c);
    if (om) { columns[c.name] = { omitted: om }; continue; }
    const vals = new Set(); let nulls = 0;
    for (const r of rows) {
      const v = cleanValue(r[c.name]);
      if (v === null) nulls++;
      else if (vals.size < 8) vals.add(String(v).slice(0, 40));
    }
    columns[c.name] = { values: [...vals], nulls };
  }
  return { table: t.name, rows: rows.length, columns };
}

/* ---------- diagnóstico opcional (DEBUG_PROMPT=true) ---------- */
// Repassa a resposta do Ollama sem alterar nada e, ao terminar, grava em
// debug/ultima-geracao-<modelo>.json: prompt, opções, resposta concatenada e a
// última mensagem do Ollama (motivo de parada, contagem de tokens).
function debugTap(payload, status) {
  const partes = [];
  return new Transform({
    transform(chunk, _enc, cb) { partes.push(chunk); cb(null, chunk); },
    flush(cb) {
      try {
        const txt = Buffer.concat(partes).toString("utf8");
        const msgs = txt.split("\n").filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return { naoJson: l }; } });
        const dir = path.join(__dirname, "debug");
        fs.mkdirSync(dir, { recursive: true });
        const nome = String(payload.model || "modelo").replace(/[^\w.-]+/g, "_");
        fs.writeFileSync(path.join(dir, `ultima-geracao-${nome}.json`), JSON.stringify({
          quando: new Date().toISOString(), status, modelo: payload.model, raw: payload.raw, format: payload.format,
          opcoes: payload.options, prompt: payload.prompt,
          resposta: msgs.map(m => m.response || "").join(""),
          final: msgs[msgs.length - 1] ? { ...msgs[msgs.length - 1], context: undefined } : null
        }, null, 2));
      } catch (e) { console.error("Falha ao gravar diagnóstico:", e.message); }
      cb();
    }
  });
}

/* =============================================================================
 * Servidor HTTP: interface estática + endpoints + proxy do Ollama
 * ========================================================================== */
http.createServer(async (req, res) => {
  try {
    // Arquivos estáticos da interface.
    if (req.method === "GET" && STATIC[req.url]) {
      const file = STATIC[req.url];
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
    }
    // Configuração pública para a interface (nada de segredos aqui).
    if (req.method === "GET" && req.url === "/api/config")
      return send(res, 200, { maxRows: MAX_ROWS, model: OLLAMA_MODEL, numCtx: OLLAMA_NUM_CTX, descModel: DESC_MODEL, sampleRows: SAMPLE_ROWS, maskSensitive: MASK_SENSITIVE });
    // Proxy do Ollama: repassa a geração ao serviço local e evita CORS no navegador.
    // Só a rota de geração usada pela interface é liberada; as demais rotas do
    // Ollama (apagar, baixar ou copiar modelos etc.) não ficam expostas.
    if (req.url.startsWith("/ollama/")) {
      if (req.method !== "POST" || req.url !== "/ollama/api/generate")
        return send(res, 404, { error: "Rota do Ollama não disponível nesta ferramenta." });
      // A janela de contexto é definida aqui (configuração do servidor), não no navegador.
      const payload = JSON.parse((await readBody(req)) || "{}");
      payload.options = { ...payload.options, num_ctx: OLLAMA_NUM_CTX };
      let r;
      try {
        r = await fetch(OLLAMA_BASE_URL + "/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } catch {
        // Falha de conectividade (Ollama desligado ou endereço errado), diferente de modelo inexistente (404).
        return send(res, 502, { error: `Ollama indisponível em ${OLLAMA_BASE_URL}. Verifique se ele está em execução (ollama serve).` });
      }
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
      // pipeline (em vez de .pipe) trata erros do stream sem derrubar o servidor e,
      // se o navegador interromper (botão Parar), cancela também a geração no Ollama.
      const etapas = [Readable.fromWeb(r.body)];
      if (DEBUG_PROMPT) etapas.push(debugTap(payload, r.status));
      return pipeline(...etapas, res, () => {});
    }
    // Endpoints da ferramenta. Erros caem no catch e viram mensagem em português.
    if (req.method === "POST" && req.url === "/api/connect")
      return send(res, 200, await connectFirebird(JSON.parse((await readBody(req)) || "{}")));
    if (req.method === "POST" && req.url === "/api/sample")
      return send(res, 200, await sampleTable(JSON.parse((await readBody(req)) || "{}").table));
    if (req.method === "POST" && req.url === "/api/validate")
      return send(res, 200, await validateFb(JSON.parse((await readBody(req)) || "{}").sql));
    if (req.method === "POST" && req.url === "/api/execute")
      return send(res, 200, await executeFb(JSON.parse((await readBody(req)) || "{}").sql));
    send(res, 404, { error: "Não encontrado." });
  } catch (err) {
    // Erro do proxy do Ollama => 502 (serviço externo); demais => 400 (pedido inválido).
    if (!res.headersSent) send(res, req.url.startsWith("/ollama/") ? 502 : 400, { error: err.message });
    else res.end();
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Text-to-SQL em http://localhost:${PORT}`);
  if (DEBUG_PROMPT) console.log("Diagnóstico ligado: últimas gerações gravadas em versão1/debug/ (desligue DEBUG_PROMPT depois).");
});
