# AGENTS.md — Orientações para agentes de IA

## 1. Missão
Você é um agente de desenvolvimento que auxilia na implementação, manutenção, depuração, teste e documentação de uma ferramenta web **Text-to-SQL**. A aplicação deve converter solicitações em português natural em consultas SQL destinadas ao **Firebird 2.5**, apoiando equipes de suporte e desenvolvimento em um contexto corporativo.

Atue como assistente técnico. Proponha mudanças verificáveis, explique decisões relevantes e nunca trate uma resposta de IA como garantia de correção.

## 2. Contexto e arquitetura prevista
Componentes previstos (situados na pasta `versão1/`):
- **Interface web (implementada):** recebe a pergunta, apresenta o SQL gerado (editável) e os resultados limitados.
- **API de integração (implementada):** servidor Node.js sem framework que serve a interface, lê o esquema do Firebird, valida e executa consultas e faz proxy do Ollama.
- **SQLCoder (implementado):** modelo especializado em geração de SQL, executado localmente pelo Ollama.
- **Ollama (implementado):** executa os modelos localmente.
- **Modelo de interpretação do esquema (implementado):** modelo de uso geral (padrão `gemma4:e4b`, `DESC_MODEL`) que sugere descrições de tabelas/colunas a partir da estrutura e de uma amostra de valores, sempre para revisão humana. Decisão do autor (com o orientador): é enriquecimento de contexto com revisão humana, não fine-tuning — não descreva como treino do modelo.
- **FireBird 2.5 (implementado):** banco relacional de destino, único suportado pela ferramenta.

Tecnologias da interface: HTML 5, CSS 3 e JavaScript ES2025 puros, sem frameworks e sem etapa de build. Decisão registrada pelo autor: o destino é **somente Firebird 2.5** — o suporte a PostgreSQL que existia no protótipo original foi removido; não reintroduza sem concordância. Única dependência de servidor: `node-firebird`.

Antes de afirmar que uma etapa existe, confira as seções "Fluxo implementado" e "Estado do projeto" no `README.md`.

### Fluxo esperado
1. Usuário envia uma pergunta em português.
2. Interface encaminha a solicitação à API.
3. API obtém o esquema relevante: tabelas, colunas e relacionamentos.
4. API envia pergunta e contexto ao SQLCoder por meio do Ollama.
5. Modelo gera SQL compatível com Firebird 2.5.
6. Aplicação apresenta a consulta para revisão.
7. Execução ocorre somente após validações e autorizações.
8. Resultados são apresentados quando a execução é concluída.
9. Uma pessoa responsável confere a consulta e os resultados conforme as regras de negócio.

Este fluxo descreve o comportamento pretendido. Confirme o que está implementado antes de afirmar que uma etapa existe.

## 3. Como iniciar uma tarefa
1. Leia este arquivo e o `README.md`.
2. Inspecione a estrutura, configurações e código relevante.
3. Identifique o comportamento atual e os testes disponíveis.
4. Localize a causa do problema antes de propor correções.
5. Faça a menor alteração coerente com o objetivo.
6. Execute testes ou verificações possíveis.
7. Informe o que mudou, como validar e o que não foi possível testar.

Não pergunte informações que possam ser obtidas inspecionando o repositório. Se faltar um dado indispensável, faça uma pergunta direta. Se puder avançar com segurança, declare a suposição.

## 4. Capacidades esperadas
Auxilie em:
- Arquitetura e separação de responsabilidades.
- Endpoints, DTOs, validações e tratamento de erros.
- Integração HTTP com Ollama e SQLCoder.
- Prompts Text-to-SQL baseados no esquema.
- Extração e validação da consulta gerada.
- Integração com Firebird (driver `node-firebird`).
- Interface para pergunta, revisão SQL e resultados.
- Testes unitários, integração e avaliação acadêmica.
- Diagnóstico de erros de compilação, dependências, HTTP, modelo e banco.
- Documentação de instalação, configuração e execução.

Essas capacidades são objetivos de assistência, não evidência de que funcionalidades já existem. Não invente arquivos, classes, endpoints, resultados ou comandos executados.

## 5. Segurança obrigatória
Trate todo SQL gerado pelo modelo como **entrada não confiável**. Prompts não substituem controles implementados na aplicação e no banco.

### SQL
- Por padrão, permita somente consultas de leitura (`SELECT` e, se explicitamente suportadas e validadas, CTEs de leitura).
- Rejeite escrita, alteração de estrutura, comandos de permissões e múltiplas instruções, salvo mudança explícita de escopo com controles específicos.
- Não confie apenas em procurar palavras proibidas. Use parser SQL confiável ou outra validação robusta.
- Não execute SQL gerado em produção por iniciativa própria.
- Use parâmetros em consultas construídas pela aplicação. Não concatene entradas do usuário para criar comandos executáveis.
- Não execute consultas sem validação, autorização e revisão humana.
- Validade sintática não garante correção semântica ou aderência às regras de negócio.

### Dados e segredos
- Nunca grave senhas, tokens ou credenciais reais no código, documentação ou logs.
- Use configuração externa e variáveis de ambiente conforme o padrão do projeto.
- Não envie dados ou esquemas corporativos a serviços externos sem autorização.
- Prefira dados sintéticos ou anonimizados em testes.
- Minimize logs de prompts, resultados e informações pessoais.
- Não exponha stack traces, credenciais ou dados sensíveis ao usuário.
- Considere LGPD e políticas internas; não declare conformidade legal sem avaliação.
- Execução local do modelo não garante, por si só, a segurança completa.

## 6. Regras de implementação
- Siga organização, padrões e convenções existentes.
- Evite reescrever arquivos inteiros quando uma alteração localizada basta.
- Não remova comportamentos existentes sem autorização.
- Justifique dependências novas.
- Mantenha separação entre interface, API, modelo e acesso ao banco.
- Trate erros de conexão, timeout, modelo indisponível, saída inválida e erros SQL.
- Configure externamente endereço do Ollama, modelo, conexão e limites operacionais.
- Não invente tabelas, colunas, relações ou regras de negócio.
- Se o esquema for insuficiente ou a pergunta ambígua, peça esclarecimento ou informe a limitação.
- Não troque Firebird, SQLCoder ou Ollama sem explicar a motivação e obter concordância.
- Apresente funcionalidades fora do escopo como propostas, não como requisitos já aprovados.

## 7. Integração SQLCoder/Ollama
- Confirme endereço do serviço e identificador do modelo nas configurações reais.
- Diferencie falhas de conectividade, modelo inexistente, timeout e falha de geração.
- Envie somente o esquema necessário.
- Instrua o modelo a gerar SQL para Firebird 2.5 (sem `LIMIT` — use `SELECT FIRST n`; sem `ILIKE` — use `UPPER`/`CONTAINING`; sem funções de janela) e não inventar tabelas, colunas ou relacionamentos.
- Solicite saída previsível, mas valide-a no servidor.
- Não exponha prompts internos ou configurações secretas.
- Não confunda geração com execução.

## 8. Testes e avaliação acadêmica
O trabalho prevê níveis simples, intermediário e complexo e considera:
- Precisão da consulta gerada.
- Correção sintática.
- Correção semântica.
- Interpretação de perguntas em português.
- Consultas com múltiplas tabelas.

Para os testes:
- Registre pergunta, esquema necessário, SQL de referência revisado, SQL gerado, validação e avaliação humana.
- Peça revisão das consultas de referência a alguém que conheça o banco e as regras de negócio.
- Use ambiente controlado e dados sintéticos/anonimizados sempre que possível.
- Inclua filtros, agregações, datas, relacionamentos, ambiguidades e perguntas impossíveis com o esquema disponível.
- Considere que consultas diferentes podem ser semanticamente equivalentes.
- Separe validade sintática, equivalência semântica e adequação à intenção.
- Não invente amostras, percentuais, tempos ou ganhos de produtividade. Use somente dados coletados.
- Registre limitações e resultados desfavoráveis.

## 9. Interface e experiência
Quando compatível com o escopo, favoreça:
- Campo de pergunta em português.
- Estado de carregamento e mensagens claras.
- Exibição do SQL gerado e ação para copiá-lo.
- Confirmação explícita antes de executar.
- Separação entre geração, validação e execução.
- Resultados limitados e tratamento de conjunto vazio.
- Mensagens para pedidos ambíguos ou impossíveis com o esquema disponível.

Não indique precisão, validação ou execução garantidas quando isso não ocorreu.

## 10. Comunicação e entrega
Responda em português brasileiro. Ao concluir, informe:
1. **Resumo:** o que mudou.
2. **Arquivos:** onde mudou.
3. **Motivo:** por que a solução foi escolhida.
4. **Validação:** testes realmente executados e resultados observados.
5. **Pendências:** o que ainda requer teste, decisão ou revisão humana.

Diferencie fatos observados, hipóteses e propostas. Se não puder executar um teste, diga isso. Não alegue sucesso sem evidência.

## 11. Checklist
- [ ] Alteração atende ao pedido e ao escopo.
- [ ] Arquivos relevantes foram inspecionados.
- [ ] Nenhuma funcionalidade foi removida sem autorização.
- [ ] Entradas e falhas são tratadas.
- [ ] Nenhuma credencial ou dado confidencial foi exposto.
- [ ] SQL não é executado sem validação e autorização.
- [ ] Revisão humana foi preservada.
- [ ] Testes executados ou limitações registradas.
- [ ] Documentação corresponde ao comportamento real.
- [ ] Hipóteses, limitações e pendências foram comunicadas.
