# Viabilidade do fine-tuning do SQLCoder (avaliação, sem scripts de treino)

> Documento de decisão. Status: **fine-tuning não iniciado**. A ferramenta usa contextualização (dicionário semântico revisado por humano). Este texto reúne o que foi verificado e o que falta verificar antes de qualquer treino, conforme a skill de análise do banco (seções 3.2, 8, 9 e 12) e o `AGENTS.md`.
>
> Data: 20/11/2026.

## 1. Decisão atual

- O "aprendizado" sobre o banco é **contextualização**: o SQLCoder interpreta tabelas e colunas, a pessoa confirma ou corrige, e as descrições vão como comentários no esquema enviado a cada pergunta. Os pesos do modelo **não mudam**.
- Esta decisão segue a registrada com o orientador no `AGENTS.md` ("enriquecimento de contexto com revisão humana, não fine-tuning") e o princípio da skill: priorizar a contextualização antes de alterar pesos.
- O fine-tuning só será considerado se a avaliação (seção 6) mostrar que a contextualização não basta.

## 2. Modelos instalados (o que o Ollama informa)

| Tag no Ollama | Origem provável | Arquitetura | Parâmetros | Formato no Ollama |
|---|---|---|---|---|
| `sqlcoder:7b` | Defog SQLCoder-7B (Hugging Face `defog/sqlcoder-7b`) | Mistral 7B (`MistralForCausalLM`); o Ollama a rotula como "llama" | 7,24 B | Q4_0, 4,1 GB |
| `sqlcoder:15b` | Defog SQLCoder (`defog/sqlcoder`) | StarCoder | 15,8 B | Q4_0, 9,0 GB |

Observações:
- A Defog marca o `sqlcoder-7b` como desatualizado e recomenda o `sqlcoder-7b-2` (base CodeLlama-7B), que **não** é o instalado. Trocar de modelo é decisão do autor (`AGENTS.md`, seção 6).
- **A confirmar na máquina** (não foi possível daqui): `ollama show sqlcoder:7b` e `ollama show sqlcoder:15b` (arquitetura, quantização, janela de contexto e licença incluída no modelo).

## 3. Licença

- Pesos do SQLCoder-7B: **CC BY-SA 4.0**. Pesos do SQLCoder 15B: CC BY-SA 4.0 com cláusulas de uso responsável (OpenRAIL-M).
- A cláusula ShareAlike costuma exigir a mesma licença para pesos derivados **distribuídos**. Para uso local no TCC, sem distribuição, isso não deve ser obstáculo, mas não é parecer jurídico: confirme com o orientador ou a instituição antes de publicar um modelo treinado.

## 4. O Ollama treina modelos?

Não. O Ollama é um ambiente de **execução** (inferência). O treino teria de ser feito fora dele, e o resultado importado depois:

- O treino precisa dos **pesos originais** (Hugging Face, FP16), não do arquivo Q4 que o Ollama usa.
- O Ollama importa adaptadores LoRA em Safetensors (`ADAPTER` no Modelfile) apenas para algumas arquiteturas: Llama, Mistral e Gemma. A documentação recomenda adaptadores **não quantizados** (LoRA comum, não QLoRA) e o **mesmo modelo base** usado no treino.
- **7B (Mistral):** caminho viável em tese: LoRA sobre `defog/sqlcoder-7b` → importação do adaptador no Ollama.
- **15B (StarCoder):** StarCoder **não** está na lista de adaptadores importáveis. Seria preciso fundir o adaptador aos pesos e converter para GGUF (ex.: ferramentas do llama.cpp). Não foi verificado se esse caminho funciona para esta arquitetura.

## 5. Requisitos ainda não verificados

| Item | Situação | Como verificar |
|---|---|---|
| GPU (modelo e memória) | desconhecido | `nvidia-smi` no Windows |
| Memória RAM e disco livre | desconhecido | `systeminfo` e espaço em disco (pesos FP16 do 7B ocupam cerca de 14 GB) |
| Framework de treino compatível com Windows | não escolhido | avaliar após saber a GPU |
| Janela de contexto e tokenizador do modelo instalado | não confirmado | `ollama show` e o `config.json` do repositório da Defog |
| Tamanho mínimo do dataset | não definido | depende do resultado da avaliação; não há número confiável sem medir |

Sem esses dados não é possível estimar tempo nem custo de treino. Não foram inventados valores.

## 6. Critério para decidir (cenários da skill, seção 12)

Usar as **mesmas perguntas** e a tela **Avaliação dos modelos** (sintaxe, semântica e erros por modelo, exportável em CSV):

- **Cenário A, SQLCoder original:** sem descrições do banco. *Pendente:* a ferramenta ainda não tem um modo "sem contexto". Hoje dá para simular exportando o contexto, limpando as descrições e importando de volta depois.
- **Cenário B, SQLCoder contextualizado:** com o dicionário semântico confirmado. É o modo atual.
- **Cenário C, SQLCoder treinado:** só se B ficar abaixo do aceitável. O critério de "aceitável" deve ser definido com o orientador **antes** de medir.

## 7. Se o treino for aprovado: dataset

- **Fontes permitidas:** exemplos pergunta → SQL já conferidos no banco (tela 1), registros da avaliação marcados como **semanticamente corretos** e revisados por alguém que conheça as regras de negócio, perguntas sintéticas.
- **Proibido:** usar automaticamente SQL gerado pelo modelo como resposta correta (reforça erros) e incluir valores de colunas sensíveis ou desconhecidas.
- **Divisão:** treino, validação e teste, sem perguntas quase idênticas em conjuntos diferentes. O teste fica isolado até o fim.
- **Dialeto:** todo SQL do dataset em Firebird 2.5 (sem `LIMIT`, `ILIKE`, booleanos ou funções de janela).

## 8. Riscos

- **Perda de capacidade geral:** o modelo pode piorar em perguntas fora do dataset.
- **Manutenção:** mudanças no esquema podem exigir novo treino, enquanto o contexto basta atualizar o dicionário.
- **Privacidade:** dados de treino ficam embutidos nos pesos. A exigência de não usar dados sensíveis é ainda mais rígida aqui.
- **Comparabilidade:** um modelo treinado só para o banco de testes pode não generalizar para outros bancos.

## 9. Próximos passos sugeridos

1. Completar a interpretação e a confirmação do dicionário semântico no banco de testes.
2. Definir com o orientador a bateria de perguntas (simples, intermediárias e complexas) e o critério de "aceitável".
3. Medir os cenários A e B nos modelos 7B e 15B com a tela de avaliação.
4. Coletar os dados da seção 5 (hardware e `ollama show`).
5. Só então decidir sobre o cenário C e documentar a estratégia escolhida antes de qualquer script de treino.

## Fontes

- Ollama, página do SQLCoder (tags 7b e 15b, arquitetura, tamanho e quantização): https://ollama.com/library/sqlcoder
- Defog, `sqlcoder-7b` (base Mistral-7B, licença CC BY-SA 4.0, aviso de modelo desatualizado): https://huggingface.co/defog/sqlcoder-7b
- Defog, `sqlcoder` 15B (base StarCoder, licença CC BY-SA 4.0 com cláusulas OpenRAIL-M): https://huggingface.co/defog/sqlcoder
- Defog, `sqlcoder-7b-2` (base CodeLlama-7B): https://huggingface.co/defog/sqlcoder-7b-2
- Ollama, importação de modelos e adaptadores (arquiteturas suportadas, recomendação de adaptador não quantizado): https://docs.ollama.com/import
