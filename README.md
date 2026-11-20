# Ferramenta Text-to-SQL para Firebird

Projeto acadêmico de desenvolvimento e avaliação de uma ferramenta baseada em Inteligência Artificial para converter solicitações em português natural em consultas SQL, com foco no apoio às equipes de suporte e desenvolvimento em ambiente corporativo.

> **Status:** versão utilizável para testes locais, de uso individual. O que está confirmado no código está descrito em "Estado do projeto" e "Fluxo implementado".

## Objetivo

Permitir que uma pessoa descreva em linguagem natural a informação desejada, receba uma consulta SQL para **Firebird 2.5**, valide-a no banco e, após confirmação explícita, execute-a com resultados limitados. A proposta é apoiar relatórios, recuperação de informações e investigação de inconsistências.

A ferramenta não elimina a necessidade de compreender o banco nem substitui a revisão das regras de negócio. SQL gerado pode estar sintaticamente correto e semanticamente errado (um exemplo real observado nos testes está registrado em "Testes executados").

## Arquitetura implementada

- **Interface web** (`versão1/index.html`, `app.js`, `styles.css`): HTML 5, CSS 3 e JavaScript ES2025 puros, sem frameworks e sem etapa de build. Três telas no menu lateral: conexão/contexto, perguntas e avaliação dos modelos.
- **API** (`versão1/server.js`): servidor Node.js sem framework que serve a interface, conecta ao Firebird, lê o esquema, valida e executa consultas e faz proxy do Ollama (somente a rota de geração `POST /api/generate`).
- **SQLCoder via Ollama:** geração local do SQL. Modelo padrão: `sqlcoder:7b`; a tela de conexão permite escolher entre `sqlcoder:7b` e `sqlcoder:15b` (o 15B precisa de `ollama pull sqlcoder:15b`, ~9 GB, e é mais lento). O histórico registra qual modelo gerou cada SQL (os testes registrados abaixo foram feitos com `sqlcoder:latest`, 7B/Q4).
- **Interpretação do esquema (SQLCoder por padrão):** o mesmo SQLCoder escolhido para as perguntas lê a estrutura (e, só das colunas classificadas como Seguras, uma amostra de valores) e devolve o significado de cada tabela e coluna, para confirmação humana. Como ele só foi treinado para escrever SQL, a interpretação é pedida como comandos `COMMENT ON TABLE/COLUMN ... IS '...'` do Firebird, que a interface lê. Alternativa opcional: um modelo de uso geral (`DESC_MODEL`, padrão `gemma4:e4b`), útil para comparar; só precisa estar instalado se for escolhido. Não é treinamento: os pesos não mudam (veja `docs/viabilidade-fine-tuning.md`).
- **Firebird 2.5:** banco relacional de destino, único suportado.

Decisões registradas pelo autor: o protótipo original (`prototipo.html`) suportava PostgreSQL e é mantido apenas como registro histórico; nesta versão o destino é **somente Firebird 2.5** e o suporte a PostgreSQL foi removido. A interface usa JavaScript puro em vez de Bootstrap/React para manter a execução simples (um único `npm start`, sem build).

## Fluxo implementado

| Etapa | Situação |
|---|---|
| 1. Usuário escreve a pergunta em português | Implementado |
| 2. Interface envia a pergunta ao servidor | Implementado (proxy `/ollama/`) |
| 3. Servidor lê o esquema (tabelas, colunas, PK/FK) + descrições do usuário | Implementado (`/api/connect`) |
| 4. Pergunta e contexto vão ao SQLCoder via Ollama | Implementado (streaming, com botão Parar) |
| 5. Modelo gera SQL compatível com Firebird 2.5 | Implementado (regras de dialeto no prompt; limpeza da saída) |
| 6. SQL apresentado para revisão (editável) e validação sem execução | Implementado (`/api/validate`) |
| 7. Execução somente após validação e confirmação explícita | Implementado (`/api/execute` + diálogo de confirmação) |
| 8. Resultados apresentados com limite e tratamento de conjunto vazio | Implementado |
| 9. Revisão final por pessoa responsável | Responsabilidade humana; a avaliação semântica (correta/incorreta) é registrada na tela após a execução |

## Estrutura do repositório

```
projeto/
├── AGENTS.md            # orientações para agentes de IA
├── README.md            # este arquivo
├── docs/
│   └── viabilidade-fine-tuning.md  # avaliação (sem scripts) do treino do SQLCoder
├── package.json         # atalho: permite npm start / npm install a partir da raiz
└── versão1/
    ├── index.html       # interface (3 telas + diálogo de confirmação)
    ├── styles.css       # estilos da interface
    ├── app.js           # lógica da interface (contexto, geração, validação, execução)
    ├── server.js        # API: esquema, validação, execução, proxy do Ollama
    ├── prototipo.html   # protótipo histórico independente; mantido só como registro
    ├── package.json
    └── .env.example     # modelo de configuração (copie para .env)
```

## Pré-requisitos

- **Node.js 20.12 ou superior** (o servidor usa `process.loadEnvFile()`).
- **Ollama** em execução, com um modelo SQLCoder disponível — padrão: `ollama pull sqlcoder:7b`. Confirme o nome real com `ollama list`.
- **Firebird 2.5** acessível (local ou rede) com um banco de testes.
- **Usuário de teste somente leitura.** Exemplo (ajuste ao seu banco):

```sql
CREATE USER TESTE PASSWORD 'SENHA_FRACA_DE_TESTE';
GRANT SELECT ON TABELA_EXEMPLO TO TESTE;
```

## Como executar

```bat
cd C:\Users\Luiz\Documents\TCC\projeto
npm install
copy versão1\.env.example versão1\.env   :: opcional: ajuste PORT, OLLAMA_BASE_URL, OLLAMA_MODEL, MAX_ROWS
npm start
```

O `npm start` funciona tanto **na raiz** (o `package.json` da raiz é um atalho para `versão1`) quanto **dentro de `versão1`** (`cd versão1` e `npm start`). O `npm install` também pode ser executado na raiz: ele instala as dependências de `versão1` automaticamente.

1. Abra `http://localhost:3000`.
2. Em **Conexão e contexto**, informe servidor, porta (padrão 3050), caminho do `.fdb`, usuário e senha → **Conectar**. O esquema do banco aparece automaticamente.
3. O contexto do banco é montado em três etapas (banco novo começa sem nada selecionado; banco já interpretado abre direto na etapa 3):
   - **1. Selecionar e classificar:** marque as tabelas e colunas que o modelo vai interpretar (as mesmas serão usadas nas perguntas). Em cada coluna escolha a privacidade: **Segura** (envia amostra de até `SAMPLE_ROWS` linhas), **Desconhecida** (padrão) ou **Sensível** (só nome, tipo e chaves). Colunas cujo nome indica dado pessoal ou BLOB ficam travadas como Sensíveis. Escolha também o **modelo da interpretação** (SQLCoder ou a alternativa `DESC_MODEL`) → **Confirmar seleção e interpretar**.
   - **2. Interpretação:** um diálogo resume o que vai ao modelo e avisa que as descrições atuais das tabelas/colunas selecionadas (inclusive as suas) serão apagadas; antes disso, um **backup JSON** do contexto é baixado. O modelo interpreta uma tabela por vez (tabelas largas em lotes de 25 colunas); dá para **Parar**.
   - **3. Revisar e confirmar:** cada descrição mostra o nível (níveis da skill): **INFERIDA** (do modelo; clique na marca para confirmar), **CONFIRMADA** (confirmada, editada ou escrita por você), **DESCONHECIDA** (o modelo não conseguiu) e **PENDENTE** (ainda não interpretada). Editar uma inferida a confirma; apagar o texto a descarta. Há "confirmar todas" por tabela e geral, e "interpretar esta tabela de novo" (preenche só o que não está confirmado). **Nova interpretação** volta à etapa 1. Todas as descrições com texto (confirmadas ou não) vão para o SQLCoder.
   - **Exportar contexto / Importar contexto**: salva ou carrega em JSON o dicionário (descrições, nível/origem, modelo e data da interpretação, classificação de privacidade, seleção) e os exemplos. Importar substitui o contexto do banco conectado; serve também para recuperar um backup automático.
   → **Ir para as perguntas**.
4. Escreva a pergunta → **Gerar SQL** (ou Ctrl+Enter). O SQL aparece em streaming; a primeira geração é mais lenta porque o modelo precisa ser carregado na memória.
5. Revise o SQL (a caixa é editável). O servidor confere a consulta no banco **sem executá-la** e avisa se o banco recusar.
6. **Executar consulta** → confirme no diálogo → os resultados aparecem em tabela (limitados a `MAX_ROWS`), com tempo gasto e aviso de truncamento.
7. Logo abaixo dos resultados, marque se a resposta do modelo está **semanticamente correta** (✓ Correta / ✕ Incorreta, com observação opcional). Clicar de novo desfaz a marcação. Se o SQL foi editado antes de executar, a tela lembra que a marcação vale para a resposta **original** do modelo.
8. **Avaliação dos modelos** (menu lateral): para cada modelo (7B e 15B), total de perguntas, sintaxe correta, semântica correta (sobre o total e sobre as revisadas) e respostas com erro, mais uma barra com a situação de cada pergunta. Abaixo, a lista das perguntas com filtros por modelo e situação, o SQL gerado (e o executado, se editado), as mensagens do banco, o tempo de geração e botões para revisar a semântica depois. **Exportar CSV** baixa todos os registros (separador `;`, abre no Excel).

### Como a avaliação é registrada

Cada geração vira um registro no navegador (`localStorage`, até 1000), com o modelo que a produziu. Não guarda dados do banco: só pergunta, SQL, situação e número de linhas.

- **Sintaxe correta:** o Firebird aceitou o SQL **como o modelo gerou**, na conferência automática feita logo após a geração. Edições posteriores não mudam esse resultado. Consultas com `WITH` (que o Firebird 2.5 não confere antes) ficam "não conferidas" até a execução, que define o resultado.
- **Semântica correta:** marcação humana após a execução (ou depois, na tela de avaliação). Só é possível para SQL que o banco não recusou.
- **Retornaram erro:** geração sem SQL utilizável (cortada pelo limite de tokens, vazia ou "I do not know"), SQL recusado pelo banco ou falha na execução. Uma consulta aceita na validação que falha ao executar conta em "sintaxe correta" e também em "erros".
- **Não registrados:** gerações interrompidas pelo botão Parar e falhas de ambiente (servidor, Ollama ou banco fora do ar, modelo não instalado), porque não medem o modelo.
- Reabrir uma pergunta do histórico reaproveita o registro original, sem duplicar.
- Os registros ficam só neste navegador: limpar os dados do navegador os apaga. Exporte o CSV para guardar os resultados da avaliação.

## Configuração

As instruções enviadas ao SQLCoder ficam em `versão1/app.js`: lista `INSTRUCTIONS` (regras, incluindo o dialeto do Firebird 2.5), `buildPrompt()` (formato do prompt e exemplos), `buildSchema()` (esquema e descrições) e as opções da chamada em `generate()`.

O servidor lê o arquivo `versão1/.env` na inicialização, mesmo quando iniciado a partir de outra pasta (veja `.env.example`):

| Variável | Padrão | Significado |
|---|---|---|
| `PORT` | `3000` | Porta da ferramenta |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Endereço do Ollama |
| `OLLAMA_MODEL` | `sqlcoder:7b` | Modelo pré-selecionado na lista da interface (7B e 15B já aparecem; outro nome é acrescentado) |
| `MAX_ROWS` | `200` | Limite de linhas por execução |
| `OLLAMA_NUM_CTX` | `8192` | Janela de contexto do modelo (tokens), aplicada pelo servidor a cada geração |
| `DESC_MODEL` | `gemma4:e4b` | Modelo de uso geral oferecido como **alternativa** ao SQLCoder na interpretação do banco (o padrão é o SQLCoder) |
| `SAMPLE_ROWS` | `20` | Linhas lidas de cada tabela para a interpretação (máximo 200) |
| `DESC_MASK_SENSITIVE` | `true` | Se `true`, nunca lê valores de colunas cujo nome indica dado pessoal (CPF, CNPJ, RG, e-mail, telefone, celular, senha, token, endereço, logradouro, nascimento, agência, conta corrente, cartão, salário), mesmo que marcadas como Seguras; BLOBs nunca são lidos |
| `DEBUG_PROMPT` | `false` | Se `true`, grava a última geração de cada modelo (prompt + resposta bruta) em `versão1/debug/` para diagnóstico. Contém esquema e pergunta: use só com banco de teste |

O modelo escolhido na lista "Modelo no Ollama" fica salvo no navegador e tem prioridade sobre `OLLAMA_MODEL`. A troca vale já na próxima geração, sem reconectar.

A conexão com o Firebird (servidor, caminho, usuário, senha) é informada na tela e fica **somente na memória do servidor**. Nenhuma credencial é gravada em disco, log ou repositório.

## Segurança

**Amostra de valores (interpretação do banco):** o filtro de privacidade fica no **servidor**, não no prompt. `/api/sample` só lê as colunas que a pessoa classificou como **Seguras**; colunas Desconhecidas ou Sensíveis nem são consultadas, e o valor nunca sai do Firebird. Com `DESC_MASK_SENSITIVE=true`, nomes que indicam dado pessoal são bloqueados mesmo se marcados como Seguros. A rota só aceita tabelas presentes no esquema lido na conexão, monta o `SELECT FIRST n` com identificadores entre aspas (nunca com texto livre) e roda na mesma transação READ ONLY. Os valores vão apenas para o Ollama local e não são gravados. Limitação: o bloqueio automático olha o **nome** da coluna; uma coluna como `OBSERVACAO` pode conter dado pessoal, por isso o padrão é Desconhecida (sem valores). Em banco real, mantenha `DESC_MASK_SENSITIVE=true` e avalie a LGPD antes de usar.

O SQL gerado pelo modelo é tratado como entrada não confiável. Camadas independentes — o SQL só chega ao banco se passar por todas:

1. **Verificação no servidor** (`assertReadable` em `server.js`): aceita apenas uma instrução iniciando com `SELECT` ou `WITH`, após remover comentários e neutralizar strings; bloqueia comandos de escrita/administração, `SELECT INTO`, `FOR UPDATE` e múltiplas instruções. **Não é um parser SQL completo** — é a primeira barreira.
2. **Transação READ ONLY no Firebird**: qualquer comando de modificação é recusado pelo próprio banco. É a garantia real de somente leitura.
3. **Limite de linhas**: a execução devolve no máximo `MAX_ROWS` linhas e sinaliza truncamento. Consultas comuns são embrulhadas em `SELECT FIRST n`, e o Firebird devolve poucas linhas mesmo que a consulta casasse com milhões.
4. **Vínculo local e privacidade**: servidor escuta apenas em `127.0.0.1`; o proxy do Ollama aceita somente `POST /ollama/api/generate`; senha não é persistida; confirmação explícita antes de executar; geração, validação e execução são etapas separadas.

Limitações de segurança assumidas:

- Firebird 2.5 não oferece `EXPLAIN` nem timeout de consulta; consultas muito amplas podem consumir recursos no servidor do banco.
- Consultas com `WITH` não podem ser embrulhadas em subselect nessa versão: ficam **sem verificação prévia** e o limite de linhas é aplicado depois da leitura (consultas `WITH` sobre tabelas muito grandes podem consumir memória).
- A proteção mais eficaz é o **usuário do banco com privilégio apenas de SELECT**; configure isso antes de usar.
- A ferramenta é de uso individual (sem autenticação); não exponha em rede nem use em produção.

## Testes executados

Registro honesto do que foi testado nesta máquina (Windows, Node v24, Ollama com `sqlcoder:latest` instalado). Ambiente sem Firebird ativo no momento dos testes de HTTP.

**Camada de verificação (`/api/validate`, sem banco conectado):**

| Entrada | Resultado |
|---|---|
| `DROP TABLE CLIENTES` | Recusada: "Somente consultas de leitura..." |
| `SELECT 1; SELECT 2` | Recusada: "Envie uma única instrução por vez." |
| `SELECT ... INTO T` | Recusada: "SELECT INTO não é permitido." |
| `SELECT ... FOR UPDATE` | Recusada: "Comando não permitido detectado: UPDATE." |
| `-- comentário` + `SELECT ...` | Passa pela verificação (comentário é ignorado corretamente) |
| `WITH X AS (...) SELECT ...` | Passa pela verificação; a validação completa exigiria banco conectado |

**Demais endpoints:** `/api/config` responde `{maxRows, model}`; `/api/connect` para um Firebird inexistente devolve mensagem clara (`connect ECONNREFUSED ::1:3050`); execução sem banco conectado devolve "Nenhum banco conectado..."; arquivos estáticos servidos com tipo correto; 404 tratado.

**Geração de ponta a ponta (proxy `/ollama/api/generate`):** com o prompt no formato do SQLCoder e um esquema de exemplo (`CLIENTES`/`VENDAS`), o modelo respondeu em ~77 s (incluindo carregamento frio do modelo):

```sql
SELECT CLIENTES.NOME FROM CLIENTES JOIN (SELECT VENDAS.ID_CLIENTE FROM VENDAS
WHERE VENDAS.VALOR > 3 GROUP BY VENDAS.ID_CLIENTE HAVING COUNT(VENDAS.ID_VENDA) > 3)
AS clientes_com_tres_vendas ON CLIENTES.ID_CLIENTE = clientes_com_tres_vendas.ID_CLIENTE;
```

A consulta é sintaticamente Firebird (sem `LIMIT`, `GROUP BY`/`HAVING` corretos), mas contém um **erro semântico**: filtrou `VALOR > 3` em vez de contar as vendas. Exemplo real do risco documentado: revisão humana é indispensável.

**Não testado (requer ambiente):** a interface em navegador de ponta a ponta. Os demais itens abaixo foram testados com banco real.

**Banco real (31/10/2026, Firebird 2.5.9 local, esquema comercial de sistema ERP):** conexão e leitura de esquema OK; limite de linhas funcionou (`truncated: true` com mais de 200 tabelas). Diagnóstico e correção de um problema real: para perguntas sobre colunas de flag, o modelo escrevia `TRUE`/`FALSE` (sintaxe de outros bancos) e a validação falhava com o erro críptico `-104, Token unknown - line 3, column 1, )` (o parser reclama do parêntese do embrulho, não do `TRUE`). Correções aplicadas: prompt reforçado ("there is NO boolean type: never write TRUE or FALSE...") e mapeamento de erros do Firebird para dicas acionáveis (`fbFriendly` em `server.js`) — testado com bateria de 16 casos: `TRUE/FALSE`, `LIMIT`, `OFFSET/FETCH`, `ILIKE`, funções de janela (`OVER`), cast `::`, parêntese órfão, coluna/tabela inexistente (-206/-204) — todos com dica clara em português. Em nova geração com o prompt corrigido, o modelo parou de emitir booleanos; citou uma coluna quase correta (`DATA_ALTERACAO` em vez de `DATAALTERACAO`), a dica apontou o ajuste, e o SQL corrigido foi validado e executado com sucesso (consulta agregada de contagem).

**Não testado (requer ambiente):** interface no navegador com Firebird simultâneo e a bateria acadêmica de perguntas.

## Testes e avaliação (acadêmico)

O trabalho prevê avaliar, em níveis simples, intermediário e complexo:

- Precisão da consulta gerada; correção sintática; correção semântica.
- Interpretação de perguntas em português; consultas envolvendo múltiplas tabelas.

Diretrizes: registre pergunta, esquema necessário, consulta de referência revisada por alguém que conheça o banco, SQL gerado, resultado da validação e avaliação humana. Use ambiente controlado com dados sintéticos ou anonimizados. Inclua filtros, agregações, datas, relacionamentos, ambiguidades e perguntas impossíveis com o esquema. Consultas diferentes podem ser semanticamente equivalentes — a comparação não deve depender de igualdade textual. Não invente métricas: apresente somente valores medidos.

## Limitações conhecidas

- O modelo pode interpretar mal perguntas ambíguas e inventar tabelas/colunas quando o contexto é insuficiente — a descrição do contexto (tela 1) é parte essencial do uso. Observação real: pode citar colunas quase corretas (ex.: `DATA_ALTERACAO` no lugar de `DATAALTERACAO`); a mensagem de validação aponta o ajuste.
- O modelo pode usar sintaxe de outros bancos (`TRUE`/`FALSE`, `LIMIT`, `ILIKE`...). O Firebird 2.5 recusa e a ferramenta traduz o erro para uma dica de correção — o SQL pode ser corrigido na caixa e revalidado sem gerar de novo.
- **Tamanho do prompt:** se esquema + descrições passarem da janela de contexto (`OLLAMA_NUM_CTX`), o Ollama descarta o excesso sem avisar e o modelo inventa nomes ou entra em loop. A interface estima o tamanho antes de gerar e avisa; a estimativa é aproximada (~3 caracteres por token). Marque só as tabelas relacionadas à pergunta.
- **Loop de repetição:** observado em uso real (o modelo repetiu `itens.nome` até o limite de 600 tokens). Quando o Ollama informa que a resposta foi cortada (`done_reason: length`), a interface avisa e não envia o SQL incompleto ao banco.
- **Consulta "inchada":** observado em uso real. Para "clientes cadastrados em cadpessoa que estão ativos", o modelo acertou `CLIENTE = 'S'`, mas escolheu `NOMEPAI` como nome e inventou filtros e subconsultas sobre `TEMPOEMPREGOATUAL`, porque nenhuma coluna marcada e descrita correspondia a "ativo". Mitigações: instrução de manter a consulta simples, descrever a coluna de situação e cadastrar exemplos.
- **Seleção automática de tabelas:** é uma comparação de palavras, não entende sinônimos nem tradução. Uma pergunta em inglês só encontra tabelas de nomes em português se as descrições tiverem as palavras em inglês. Citar o nome da tabela na pergunta (ex.: "CADRECEBER") força a escolha. As tabelas enviadas aparecem abaixo da pergunta.
- **Filtros copiados de exemplos:** observado em uso real com o 7B. Um exemplo salvo com `CLIENTE = 'S'` fez o filtro aparecer em perguntas que não pediam essa restrição. Mitigação: só exemplos parecidos com a pergunta entram no prompt, com instrução para não copiar filtros; a linha abaixo da pergunta informa quantos exemplos foram incluídos.
- **Nomes "padronizados" pelo modelo:** observado em uso real (`COD_TIPO_PGTO` no lugar de `COD_TIPOPGTO`, `DATA_ALTERACAO` no lugar de `DATAALTERACAO`). Antes de conferir no banco, a interface compara tabelas (após FROM/JOIN) e colunas qualificadas (`TABELA.COLUNA` ou `APELIDO.COLUNA`) com o esquema lido e avisa o nome provável. Por decisão do autor, só avisa: o SQL não é alterado. Colunas sem prefixo não são conferidas.
- SQL sintaticamente válido pode estar semanticamente errado (exemplo real registrado em "Testes executados"); a validação do servidor confere sintaxe e existência de objetos, não regras de negócio.
- BLOBs aparecem como marcador (`[binário]`/`[objeto]`) na tabela de resultados.
- Valores `DECIMAL`/`NUMERIC` podem chegar como texto (comportamento do driver).
- Datas são exibidas no fuso local da máquina.
- Regras de negócio nem sempre podem ser deduzidas do esquema; a revisão humana continua necessária.
- **Interpretação pelo SQLCoder não testada com o modelo real:** o SQLCoder foi treinado para gerar SQL a partir de perguntas, não para descrever tabelas. O formato `COMMENT ON` foi escolhido para aproximar a tarefa do que ele conhece, mas ele pode responder em inglês, deixar colunas sem comentário (ficam DESCONHECIDAS), repetir textos ou devolver "I do not know". Compare com a alternativa `DESC_MODEL` antes de concluir.
- **Fine-tuning:** não implementado. Avaliação de viabilidade e próximos passos em `docs/viabilidade-fine-tuning.md`.

## Estado do projeto

- **Implementado (confirmado no código):** conexão e leitura de esquema do Firebird 2.5; seleção de tabelas e colunas enviadas ao modelo; seleção automática, entre as marcadas, das tabelas relacionadas à pergunta (heurística por palavras: nome citado na pergunta, nome/descrição de tabela e coluna; as tabelas enviadas aparecem abaixo da pergunta); exemplos pergunta → SQL conferido por banco (até 3 por pergunta, só os parecidos com ela — ao menos metade das palavras relevantes em comum — e só com tabelas enviadas, com instrução para não copiar filtros); prompt no formato oficial do SQLCoder (`### Instructions`, com resposta "I do not know" tratada); interpretação do banco em etapas (seleção e classificação de privacidade → confirmação com backup e limpeza → interpretação pelo SQLCoder via `COMMENT ON`, com modelo de uso geral opcional → revisão com níveis CONFIRMADA/INFERIDA/DESCONHECIDA/PENDENTE) e filtro de privacidade no servidor; exportação/importação do contexto em JSON; contexto descritivo salvo no navegador; geração via SQLCoder/Ollama com streaming e interrupção; validação sem execução; execução com confirmação explícita, transação READ ONLY e limite de linhas; resultados com tratamento de vazio/truncamento; revisão semântica após a execução e tela de avaliação por modelo (sintaxe, semântica e erros, com exportação CSV); SQL editável antes de validar/executar; histórico local; cópia do SQL; configuração por `.env`.
- **Testado:** ver "Testes executados" (camada HTTP, verificação de segurança e geração com modelo real).
- **Planejado:** bateria de avaliação acadêmica por níveis; propostas futuras (ex.: exportação de resultados em CSV) não estão aprovadas.
- **Limitações pendentes:** comportamento com bancos grandes; qualidade com perguntas ambíguas; desempenho de geração em máquinas modestas.

## Contexto acadêmico

O projeto investiga a viabilidade de utilizar um modelo especializado em Text-to-SQL para apoiar a recuperação de informações em bases relacionais de um ambiente corporativo. A avaliação deve considerar a qualidade das consultas e preservar a confidencialidade dos esquemas e dados empresariais.

## Orientações para agentes de IA

O arquivo [`AGENTS.md`](AGENTS.md) contém instruções para agentes que trabalham neste repositório: inspeção inicial, implementação, depuração, segurança de SQL, avaliação acadêmica e comunicação dos resultados. Leia o `AGENTS.md` antes de iniciar uma tarefa de desenvolvimento.
