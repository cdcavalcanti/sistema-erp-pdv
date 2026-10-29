# ADR-0007 — IA com ferramentas de leitura, rascunhos e dados pessoais mascarados

**Status:** aceito

## Contexto
A seção 20 prevê classificação de NCM, leitura de documentos, perguntas em linguagem
natural, agente de cobrança, previsões e anomalias. As regras RN-IA-01 a 03 exigem que a IA
não grave nada sozinha, que respeite as permissões do usuário e que nunca enxergue dados
de outro tenant.

## Decisão
- A interface `AiModel` tem duas implementações: `AnthropicAiModel` (Claude via
  `@anthropic-ai/sdk`, modelo configurável em `AI_MODEL`) e `DisabledAiModel`. Sem chave,
  cada funcionalidade cai para regras determinísticas.
- As ferramentas expostas ao modelo só leem e rodam com o contexto (RLS e permissões) do
  usuário que perguntou. Toda proposta de escrita vira um **rascunho** (`ai.drafts`), que
  uma pessoa com a permissão correspondente confirma ou descarta.
- CPF, CNPJ, e-mail e telefone são trocados por marcadores antes do envio e restaurados
  na resposta (`redact`/`restore`).
- Toda chamada é registrada em `ai.calls` (tokens, custo, latência) e emite `ia.consumo`
  para medição.

## Consequências
- Os testes usam um modelo roteirizado (`FakeAi`) e não acessam a rede.
- O custo da IA aparece por tenant e pode ser cobrado por consumo.
