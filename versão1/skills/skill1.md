---
name: sqlcoder-database-training
description: Analisa bancos Firebird 2.5 utilizando SQLCoder, identifica o significado semântico de tabelas e colunas, constrói contexto para Text-to-SQL e prepara, avalia e executa estratégias de treinamento do próprio SQLCoder, respeitando rigorosamente a privacidade dos dados.
---

# Skill: SQLCoder Database Analysis and Training

## 1. Objetivo

Esta Skill orienta o desenvolvimento de uma solução capaz de preparar e especializar o modelo SQLCoder para trabalhar com bancos de dados Firebird 2.5.

O objetivo é permitir que o SQLCoder compreenda a estrutura e o significado de um banco de dados específico, identificando:

- O propósito de cada tabela.
- O significado provável de cada coluna.
- Os relacionamentos entre tabelas.
- Os campos utilizados para identificação, classificação e agrupamento.
- Os possíveis valores de enumerações e campos de status.
- As regras de negócio que podem ser inferidas a partir da estrutura.
- As relações necessárias para responder a perguntas em linguagem natural.

Depois da análise, o sistema deverá utilizar esse conhecimento para preparar o SQLCoder para receber perguntas em português e gerar consultas SQL compatíveis com Firebird 2.5.

**O SQLCoder deve ser o modelo principal durante todo o processo. Não utilizar Gemma ou outro LLM como dependência obrigatória para interpretar o banco ou produzir os dados de treinamento.**

## 2. Responsabilidades do agente

O agente de desenvolvimento deve:

1. Inspecionar a arquitetura atual do projeto antes de propor alterações.
2. Identificar a versão do SQLCoder utilizada e suas características.
3. Identificar os recursos disponíveis no ambiente, incluindo hardware, memória e armazenamento.
4. Analisar a estrutura do banco Firebird 2.5.
5. Classificar os campos conforme seu nível de sensibilidade.
6. Impedir que informações sensíveis sejam encaminhadas ao modelo.
7. Utilizar SQLCoder para interpretar a estrutura e os exemplos permitidos.
8. Criar uma documentação semântica do banco.
9. Preparar dados de treinamento a partir de exemplos sintéticos e consultas validadas.
10. Avaliar a necessidade e a viabilidade do treinamento adicional.
11. Executar experimentos controlados e comparar os resultados.
12. Documentar decisões, limitações e resultados.

Não presumir que o treinamento seja necessário. Primeiro, verificar se o fornecimento de contexto semântico ao SQLCoder já é suficiente.

## 3. Modelo de linguagem

### 3.1 SQLCoder

O SQLCoder será utilizado como modelo principal e deverá desempenhar duas funções:

**Etapa A — Interpretação do banco de dados**

Receber informações estruturais do banco, como:
- Nome das tabelas.
- Nome das colunas.
- Tipos de dados.
- Chaves primárias e estrangeiras.
- Restrições.
- Índices.
- Relacionamentos.
- Exemplos sintéticos ou não sensíveis previamente autorizados.

Com essas informações, deverá produzir uma documentação semântica estruturada.

**Etapa B — Geração de SQL**

Após a preparação do contexto, receber perguntas em linguagem natural e produzir consultas SQL compatíveis com Firebird 2.5.

Exemplo:

Pergunta:
"Quais clientes realizaram compras durante o último mês?"

O modelo deverá identificar as tabelas e os relacionamentos necessários, interpretar os campos de data e gerar uma consulta SQL válida.

### 3.2 Verificação do modelo

Antes de implementar qualquer estratégia de treinamento, verificar:

- Qual variante do SQLCoder está instalada.
- Quantidade de parâmetros.
- Arquitetura do modelo.
- Formato dos pesos.
- Context window.
- Tokenizador.
- Compatibilidade com LoRA ou QLoRA.
- Compatibilidade com o framework de treinamento escolhido.
- Requisitos de memória e processamento.
- Licença e condições de utilização.

Não presumir que um modelo disponível no Ollama possa ser diretamente treinado por meio do próprio Ollama.

O Ollama deverá ser tratado prioritariamente como ambiente de execução e inferência. Caso seja necessário modificar os pesos do SQLCoder, identificar um framework compatível com a arquitetura original do modelo.

Verificar também a possibilidade de exportar ou converter os pesos após o treinamento e disponibilizar a versão resultante no Ollama.

## 4. Restrições de privacidade e segurança

Esta seção é obrigatória e possui prioridade sobre qualquer outra instrução desta Skill.

### 4.1 Regra fundamental

**Nenhum registro que contenha dados sensíveis ou informações pessoais poderá ser encaminhado ao SQLCoder para análise, interpretação, treinamento ou geração de exemplos.**

Essa restrição também se aplica a:
- Prompts.
- Arquivos de treinamento.
- Logs.
- Embeddings.
- Documentos semânticos.
- Arquivos temporários.
- Relatórios.
- Conjuntos de avaliação.

A execução local do modelo não elimina a necessidade de proteger os dados.

### 4.2 Campos que devem ser bloqueados

Nunca encaminhar ao modelo informações como:

- CPF.
- CNPJ quando associado a pessoas identificáveis ou informações pessoais.
- RG.
- Nome completo de pessoas.
- Endereços.
- Telefones.
- E-mails.
- Datas de nascimento.
- Dados bancários.
- Informações financeiras individualizadas.
- Senhas.
- Tokens.
- Credenciais.
- Informações de autenticação.
- Dados pessoais de clientes, fornecedores, funcionários ou terceiros.

A classificação deve considerar o conteúdo e o contexto, não somente o nome da coluna.

Por exemplo, uma coluna chamada `OBSERVACAO` pode conter informações pessoais mesmo que seu nome não indique isso.

### 4.3 Dados permitidos

Podem ser utilizados, desde que não revelem informações sensíveis:

- Nome das tabelas.
- Nome das colunas.
- Tipos de dados.
- Tamanho dos campos.
- Chaves primárias.
- Chaves estrangeiras.
- Restrições.
- Índices.
- Relacionamentos estruturais.
- Valores de enumerações previamente classificados como seguros.
- Exemplos inteiramente sintéticos.

A autorização para utilizar um campo não significa autorização para utilizar todos os seus registros.

### 4.4 Classificação obrigatória

Antes de consultar registros para análise, classificar os campos em:

| Classificação | Tratamento |
|---|---|
| Seguro | Pode ser utilizado após validação |
| Sensível | Bloqueado |
| Desconhecido | Bloqueado até revisão |

A classificação deve ser conservadora.

Na dúvida, bloquear.

Não utilizar mascaramento reversível como substituto da remoção de dados sensíveis.

Não encaminhar valores reais para o modelo com a intenção de solicitar que ele os ignore.

### 4.5 Implementação do filtro

Criar uma camada independente responsável por impedir o envio de informações proibidas.

O fluxo obrigatório será:

1. Consultar metadados.
2. Identificar os campos.
3. Classificar os campos.
4. Aplicar a lista de bloqueio.
5. Validar os dados permitidos.
6. Construir a entrada do modelo.
7. Encaminhar somente o conteúdo autorizado.

O filtro deve atuar antes de qualquer chamada ao SQLCoder.

Não depender exclusivamente de instruções escritas no prompt para proteger informações sensíveis.

Os logs devem registrar somente informações técnicas, como:
- Quantidade de campos analisados.
- Quantidade de campos bloqueados.
- Motivo da classificação.
- Identificador técnico da execução.

Nunca registrar os valores bloqueados.

## 5. Análise do banco Firebird 2.5

### 5.1 Descoberta estrutural

Utilizar as tabelas de sistema do Firebird para identificar a estrutura do banco.

Consultar, quando necessário e quando existente:

- `RDB$RELATIONS`
- `RDB$RELATION_FIELDS`
- `RDB$FIELDS`
- `RDB$FIELD_DIMENSIONS`
- `RDB$RELATION_CONSTRAINTS`
- `RDB$REF_CONSTRAINTS`
- `RDB$INDEX_SEGMENTS`
- `RDB$INDICES`
- `RDB$CHECK_CONSTRAINTS`
- `RDB$TRIGGERS`

Identificar:
- Tabelas de usuário.
- Colunas.
- Tipos de dados.
- Domínios.
- Chaves primárias.
- Chaves estrangeiras.
- Índices.
- Restrições.
- Relacionamentos.

Não confundir tabelas de sistema com tabelas de negócio.

Não presumir que todas as relações estejam declaradas por meio de chaves estrangeiras. Investigar possíveis relações implícitas, mas identificá-las como inferências.

### 5.2 Análise de colunas

Para cada coluna autorizada, o SQLCoder deverá analisar:

- Nome.
- Tipo.
- Tamanho.
- Nulabilidade.
- Domínio.
- Tabela de origem.
- Relacionamentos conhecidos.
- Exemplos permitidos, quando disponíveis.

O objetivo é descobrir o significado funcional do campo.

Exemplo:

Tabela: `PRODUTO`

| Campo | Tipo | Interpretação |
|---|---|---|
| CODPRO | INTEGER | Identificador do produto |
| DESPRO | VARCHAR | Descrição do produto |
| PREPRO | NUMERIC | Preço do produto |
| SITPRO | CHAR | Possível situação cadastral |

As interpretações são exemplos e devem ser confirmadas com a estrutura e o contexto do banco real.

### 5.3 Análise de valores

Quando autorizado, utilizar amostras pequenas de valores não sensíveis para auxiliar a interpretação.

Exemplo:

Campo: `SITPRO`

Valores sintéticos:
- A
- I
- B

Possível interpretação:
- A = Ativo.
- I = Inativo.
- B = Bloqueado.

O SQLCoder deve apresentar essas interpretações como hipóteses até que exista confirmação.

Não utilizar valores reais de campos desconhecidos sem antes classificá-los como seguros.

Não utilizar amostras de registros completos indiscriminadamente.

## 6. Construção do dicionário semântico

O resultado da análise deverá ser armazenado em um documento estruturado, preferencialmente JSON.

Exemplo:

```json
{
  "database": "LOJA",
  "dialect": "Firebird 2.5",
  "tables": [
    {
      "name": "PRODUTO",
      "description": "Armazena os produtos comercializados.",
      "columns": [
        {
          "name": "CODPRO",
          "type": "INTEGER",
          "meaning": "Identificador único do produto.",
          "confidence": "CONFIRMADA",
          "sensitive": false
        },
        {
          "name": "DESPRO",
          "type": "VARCHAR",
          "meaning": "Descrição comercial do produto.",
          "confidence": "INFERIDA",
          "sensitive": false
        }
      ]
    }
  ]
}
```

Cada interpretação deve possuir um nível de confiança:

- `CONFIRMADA`: comprovada por metadados, documentação ou validação humana.
- `INFERIDA`: interpretação provável, mas não confirmada.
- `PENDENTE`: necessita de investigação.
- `DESCONHECIDA`: não foi possível identificar o significado.

O dicionário deverá incluir também:

- Descrição das tabelas.
- Descrição das colunas.
- Relacionamentos.
- Regras de negócio identificadas.
- Campos de classificação.
- Possíveis enumerações.
- Restrições conhecidas.
- Exemplos sintéticos.
- Origem da interpretação.
- Data da análise.

Não transformar inferências em regras confirmadas automaticamente.

## 7. Preparação do SQLCoder para o banco

Antes de realizar fine-tuning, implementar uma estratégia de contextualização.

### 7.1 Contexto semântico

O sistema deverá recuperar as informações relevantes do dicionário semântico conforme a pergunta recebida.

Exemplo:

Pergunta:
"Quais produtos estão disponíveis para venda?"

O sistema deverá recuperar:
- Tabela de produtos.
- Colunas relacionadas à identificação.
- Colunas relacionadas à disponibilidade.
- Significado dos possíveis status.
- Relacionamentos necessários.

O contexto recuperado será fornecido ao SQLCoder juntamente com a pergunta.

### 7.2 Recuperação de contexto

Avaliar estratégias como:

- Busca por palavras-chave.
- Busca por nomes de tabelas e colunas.
- Busca por descrições semânticas.
- Busca vetorial, se houver necessidade.
- Recuperação de relacionamentos relevantes.

Não carregar indiscriminadamente todo o banco no prompt.

O contexto deve ser limitado às informações necessárias para a pergunta.

### 7.3 Separação entre contexto e treinamento

Manter os seguintes conceitos separados:

- Dicionário semântico: documentação do banco.
- Contexto recuperado: informações utilizadas durante a inferência.
- Dataset: exemplos utilizados para treinamento ou avaliação.
- Modelo treinado: versão do SQLCoder com pesos adaptados.

A atualização do banco não deve exigir automaticamente um novo treinamento.

Sempre avaliar se basta atualizar o dicionário semântico.

## 8. Preparação dos dados de treinamento

O SQLCoder deverá ser utilizado para auxiliar na criação de exemplos de treinamento específicos para o banco.

### 8.1 Origem dos exemplos

Os exemplos poderão ser produzidos a partir de:

- Perguntas sintéticas em português.
- Consultas SQL previamente validadas.
- Documentação semântica.
- Regras de negócio confirmadas.
- Cenários de utilização fictícios.
- Exemplos construídos manualmente.

O SQLCoder poderá propor perguntas e consultas, mas os exemplos deverão ser validados antes de integrar o dataset.

### 8.2 Formato dos exemplos

Utilizar uma estrutura consistente, por exemplo:

```json
{
  "question": "Quais produtos estão cadastrados?",
  "schema_context": "Tabela PRODUTO: CODPRO identifica o produto e DESPRO contém sua descrição.",
  "sql": "SELECT CODPRO, DESPRO FROM PRODUTO"
}
```

O formato final deverá ser adaptado ao framework de treinamento escolhido.

### 8.3 Validação

Cada exemplo deverá passar por:

1. Verificação da pergunta.
2. Verificação do contexto semântico.
3. Verificação da sintaxe SQL.
4. Verificação de compatibilidade com Firebird 2.5.
5. Verificação de segurança.
6. Execução controlada, quando autorizada.
7. Revisão do resultado esperado.

Não utilizar automaticamente uma consulta gerada pelo próprio modelo como exemplo correto.

Isso pode reforçar erros e interpretações equivocadas.

### 8.4 Separação dos conjuntos

Dividir os dados em:

- Treinamento.
- Validação.
- Teste.

Evitar que perguntas praticamente idênticas apareçam em conjuntos diferentes.

O conjunto de teste deverá permanecer isolado durante o treinamento e os ajustes.

## 9. Estratégia de treinamento

O agente deverá investigar qual estratégia é tecnicamente viável para a variante do SQLCoder instalada.

Avaliar:

### 9.1 Fine-tuning completo

Modificar os pesos do modelo utilizando o dataset específico.

Considerar:
- Consumo de memória.
- Capacidade de processamento.
- Tempo de treinamento.
- Tamanho do dataset.
- Risco de perda de conhecimento geral.
- Viabilidade de manutenção.


### 9.3 Escolha da estratégia

A escolha deve considerar:
- Hardware disponível.
- Variante do modelo.
- Quantidade e qualidade dos exemplos.
- Compatibilidade do framework.
- Resultados obtidos na avaliação inicial.

Não iniciar treinamento antes de documentar a estratégia escolhida e suas justificativas.

## 10. Compatibilidade com Firebird 2.5

O SQLCoder deve produzir SQL compatível com o banco utilizado pelo projeto.

Não assumir que os exemplos de treinamento originalmente utilizados pelo modelo sejam suficientes para garantir compatibilidade com Firebird.

Observar especialmente:

- Sintaxe de `SELECT`.
- `JOIN`.
- `GROUP BY`.
- `ORDER BY`.
- `FIRST` e `SKIP`.
- `ROWS`.
- Funções de data.
- Funções de texto.
- Conversões de tipos.
- Subconsultas.
- Expressões condicionais.
- Tratamento de valores `NULL`.
- Tipos numéricos.
- Diferenças de sintaxe entre Firebird e PostgreSQL.

Não utilizar sintaxe exclusiva de PostgreSQL ou MySQL sem verificar sua compatibilidade.

Todos os exemplos de treinamento deverão utilizar o dialeto correspondente ao Firebird 2.5.

## 11. Segurança na geração e execução de SQL

A geração de consultas não significa autorização automática para executá-las.

O sistema deverá implementar proteção em camadas.

### 11.1 Consultas permitidas

Na primeira versão, permitir somente consultas de leitura.

Bloquear:
- `INSERT`
- `UPDATE`
- `DELETE`
- `DROP`
- `ALTER`
- `CREATE`
- `TRUNCATE`
- Comandos administrativos.
- Execução de múltiplas instruções não autorizadas.

### 11.2 Validação

Antes da execução:
1. Verificar se a saída é uma instrução permitida.
2. Validar a sintaxe.
3. Verificar referências às tabelas e colunas existentes.
4. Aplicar limites de execução e quantidade de resultados.
5. Utilizar uma conexão com permissões somente de leitura.
6. Registrar informações técnicas da execução.

A segurança não pode depender exclusivamente do comportamento esperado do modelo.

Não executar SQL gerado diretamente em produção sem validação.

## 12. Avaliação dos resultados

Comparar o SQLCoder original com a versão contextualizada e, posteriormente, com a versão treinada.

Utilizar as mesmas perguntas e condições para todos os experimentos.

### 12.1 Critérios

Avaliar:

- Identificação correta das tabelas.
- Identificação correta das colunas.
- Interpretação dos relacionamentos.
- Compreensão dos campos de status.
- Compatibilidade com Firebird 2.5.
- Validade sintática.
- Execução correta.
- Correspondência entre resultado obtido e resultado esperado.
- Tempo de resposta.
- Consumo de recursos.

### 12.2 Experimentos

Executar, no mínimo, três cenários:

**Cenário A — SQLCoder original**

Modelo sem documentação específica do banco.

**Cenário B — SQLCoder contextualizado**

Modelo original recebendo o dicionário semântico e contexto recuperado.

**Cenário C — SQLCoder treinado**

Modelo adaptado com o dataset validado e recebendo o contexto necessário.

Comparar os resultados para identificar se o treinamento realmente trouxe benefícios em relação à contextualização.

Não considerar o treinamento bem-sucedido somente porque o modelo produz consultas aparentemente mais adequadas.

A avaliação deve considerar a execução e a correção dos resultados.

## 13. Arquitetura sugerida

```text
                 BANCO FIREBIRD 2.5
                         |
                         v
               EXTRATOR DE METADADOS
                         |
                         v
                CLASSIFICADOR DE DADOS
                         |
                  +------+------+
                  |             |
                  v             v
           DADOS SEGUROS   DADOS BLOQUEADOS
                  |
                  v
             SQLCODER
          ANÁLISE SEMÂNTICA
                  |
                  v
           DICIONÁRIO SEMÂNTICO
                  |
                  v
          GERAÇÃO DE DATASET
                  |
                  v
             VALIDAÇÃO
                  |
                  v
          TREINAMENTO OPCIONAL
                  |
                  v
           SQLCODER ADAPTADO
                  |
                  v
             INFERÊNCIA
                  |
                  v
          PERGUNTA EM PORTUGUÊS
                  |
                  v
          CONTEXTO RECUPERADO
                  |
                  v
             SQLCODER
                  |
                  v
          VALIDAÇÃO DO SQL
                  |
                  v
          CONSULTA FIREBIRD
```

## 15. Fluxo obrigatório de desenvolvimento

Ao receber uma solicitação relacionada a esta Skill:

1. Inspecionar o projeto atual.
2. Identificar a tecnologia e a arquitetura existentes.
3. Verificar a versão do Firebird.
4. Verificar a variante do SQLCoder.
5. Verificar o ambiente Ollama.
6. Verificar hardware e recursos disponíveis.
7. Identificar os mecanismos de proteção de dados.
8. Apresentar uma proposta técnica.
9. Implementar em etapas pequenas.
10. Testar cada etapa.
11. Documentar os resultados.
12. Evitar alterações desnecessárias na arquitetura existente.

Não criar scripts de treinamento antes de verificar a compatibilidade entre modelo, pesos, tokenizador e framework.

Não baixar ou substituir modelos sem autorização.

Não executar alterações destrutivas no banco.

Não utilizar dados sensíveis em testes.

## 16. Princípios obrigatórios

- SQLCoder é o modelo principal.
- Não utilizar Gemma como dependência.
- Não encaminhar dados sensíveis ao modelo.
- Não presumir o significado de campos sem evidências.
- Não considerar inferências como fatos confirmados.
- Não iniciar fine-tuning sem uma avaliação de necessidade.
- Priorizar contextualização semântica antes de alterar pesos.
- Utilizar exclusivamente SQL compatível com Firebird 2.5.
- Validar todos os exemplos de treinamento.
- Não executar consultas potencialmente destrutivas.
- Não modificar o banco original durante a análise.
- Não comprometer a capacidade geral do modelo sem demonstrar benefício.
- Documentar todas as decisões técnicas.

## 17. Resultado esperado

Ao final do processo, deverá existir uma solução capaz de:

1. Conectar-se a um banco Firebird 2.5.
2. Extrair automaticamente seus metadados.
3. Classificar campos e bloquear informações sensíveis.
4. Utilizar SQLCoder para interpretar a estrutura.
5. Construir um dicionário semântico do banco.
6. Preparar contexto para perguntas em linguagem natural.
7. Criar datasets sintéticos e validados.
8. Treinar ou adaptar SQLCoder quando tecnicamente justificável.
9. Gerar consultas SQL compatíveis com Firebird 2.5.
10. Avaliar a precisão das consultas produzidas.

O resultado deve ser uma solução modular, segura, reproduzível e capaz de ser adaptada a diferentes bancos de dados sem exigir que o modelo seja treinado novamente a cada alteração estrutural.