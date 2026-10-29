# Operação

Roteiros dos requisitos não funcionais (seção 24) e dos itens da seção 25 que dependem
de ambiente real e, por isso, não rodam no CI.

## 1. Homologação SEFAZ (seção 25)

Todo fluxo fiscal deve ser testado no **ambiente de homologação** (`SEFAZ_AMBIENTE=2`)
de pelo menos 3 UFs, incluindo **Pernambuco**. Sugestão: PE, SP (SEFAZ própria) e uma UF
autorizada pela SVRS (por exemplo, PB ou RN).

Pré-requisitos: certificado A1 de homologação no cofre (`POST /v1/establishments/:id/certificate`),
`FISCAL_GATEWAY=partner` com o token do parceiro de homologação e a série de testes cadastrada.

| # | Fluxo | Como verificar | PE | UF 2 | UF 3 |
|---|---|---|---|---|---|
| 1 | NF-e de venda interna e interestadual (com DIFAL para não contribuinte) | `autorizada`, protocolo e XML guardado | ☐ | ☐ | ☐ |
| 2 | NFC-e | QR Code e `autorizada` | ☐ | ☐ | ☐ |
| 3 | Grupos IBS/CBS preenchidos (cClassTrib) | sem rejeição de leiaute | ☐ | ☐ | ☐ |
| 4 | Cancelamento dentro do prazo (RN-NFE-05) | evento 110111 homologado | ☐ | ☐ | ☐ |
| 5 | Carta de correção (CC-e) | evento 110110, sequência incrementa | ☐ | ☐ | ☐ |
| 6 | Inutilização de numeração | faixa inutilizada e protocolo | ☐ | ☐ | ☐ |
| 7 | Contingência (SVC / offline NFC-e) e retransmissão | documento sai de `contingencia` para `autorizada` | ☐ | ☐ | ☐ |
| 8 | Devolução referenciando a nota original por item | `autorizada` com a referência | ☐ | ☐ | ☐ |
| 9 | Manifestação do destinatário e distribuição de DF-e | notas de entrada aparecem no recebimento | ☐ | ☐ | ☐ |
| 10 | NFS-e nacional (Simples a partir de 1º/11/2026) | DPS aceita e NFS-e gerada | ☐ | ☐ | ☐ |

Registre data, UF, versão do sistema e protocolos numa cópia desta tabela no card da entrega.

## 2. Backup e restauração (seção 24)

- **Meta:** RPO de 5 minutos e RTO de 4 horas.
- **Contínuo:** PITR do Postgres (WAL arquivado a cada 60 s ou 16 MB e base backup diário),
  em bucket com versionamento e Object Lock. O XML fiscal (`STORAGE_DIR` / S3) já é imutável.
- **Teste mensal de restauração (documentado):**
  1. Restaurar o último base backup num servidor isolado, com PITR até "agora − 10 min".
  2. `pnpm db:migrate`, que deve informar que não há nada a aplicar.
  3. Verificar a contagem de tenants, de documentos fiscais do mês e de lançamentos contábeis
     contra a produção no mesmo instante.
  4. Abrir o balancete de um tenant de teste e comparar com a produção.
  5. Registrar o tempo total (deve ficar abaixo do RTO), os problemas e as correções.

## 3. Observabilidade

- **Logs:** JSON (pino). Cada requisição tem `reqId` (devolvido em `X-Request-Id`), e os erros
  registram o tenant.
- **Métricas:** `GET /metrics` no formato Prometheus. Em produção, exige `METRICS_TOKEN`
  como Bearer e, sem ele, responde 404.

| Métrica | Uso |
|---|---|
| `vortex_http_requests_total{method,route,status}` | volume e taxa de erro por rota |
| `vortex_http_request_duration_seconds` (histograma) | p95 abaixo de 500 ms em consultas e abaixo de 1 s ao salvar um pedido |
| `vortex_http_errors_total{code}` | erros de negócio (`VALIDATION`, `FORBIDDEN`…) e `INTERNAL` |
| `vortex_jobs{queue,status}`, `vortex_jobs_oldest_ready_seconds` | fila parada ou com jobs `dead` |
| `vortex_outbox_pending`, `vortex_webhook_deliveries_failed` | integrações atrasadas |
| `vortex_fiscal_documents_24h{model,status}` | rejeições e contingência na emissão |

- **Alertas sugeridos (VORTEX Sentinel):** `INTERNAL` acima de 1% em 5 min; job pronto há mais de
  10 min; `dead` acima de 0; `contingencia` ou `rejeitada` acima de 5% das emissões em 1 h. Os
  eventos `certificado.vencendo` e `fiscal.contingencia` também chegam pelo outbox.

## 4. Segurança e LGPD

- TLS termina no proxy (`infra/docker/nginx.conf`). Segredos e certificados ficam no cofre
  (`core.secrets`, AES-256-GCM com `SECRETS_MASTER_KEY`). Em produção, a chave mestra vem do KMS.
- MFA é obrigatória para o perfil administrador. `JWT_SECRET` e `PROVISIONING_KEY` precisam ter
  pelo menos 32 caracteres em produção, ou a API não sobe.
- RLS e as FKs compostas são testadas a cada commit (`tenant-isolation.test.ts`).
  A auditoria de dependências roda no CI.
- **Titular de dados (RN-ACE-04):** `GET /v1/parties/:id/lgpd-export` exporta os dados e
  `POST /v1/parties/:id/anonymize` os anonimiza, mantendo os documentos fiscais exigidos por lei.
  As duas ações ficam na auditoria.
- **Incidentes:** registre data, escopo, tenants afetados e comunicação à ANPD e aos clientes em
  até 2 dias úteis. Use o log de auditoria (`core.audit_log`) para definir o escopo.
- Faça um teste de intrusão externo antes do lançamento.
- **Exceções da auditoria de dependências** (`pnpm.auditConfig.ignoreGhsas` no `package.json` da raiz).
  Revise cada uma a cada release e remova assim que houver correção:

| Aviso | Pacote | Por que não afeta | Revisar quando |
|---|---|---|---|
| GHSA-86w9-cpqp-85rv | node-forge (sem versão corrigida) | O forge só abre o PFX do certificado (`org/service.ts`: `pkcs12FromAsn1`). Não verifica assinaturas RSA PKCS#1 v1.5, que é o código vulnerável. A assinatura dos XML fica no parceiro emissor | sair uma versão corrigida, ou se o ERP passar a assinar e verificar XML localmente |

## 5. Piloto assistido (seção 25)

Antes de vender, rode o sistema em 2 a 3 clientes reais, em paralelo ao sistema atual
deles, por pelo menos um fechamento de mês completo.

1. Implante com as tabelas oficiais completas (`docs/tabelas-oficiais.md`) e o certificado de produção.
2. Na primeira semana, emita em homologação em paralelo e compare os impostos de cada nota
   com o sistema atual. Toda divergência vira um caso dourado novo.
3. No fechamento, compare o faturamento, o livro de saídas e de entradas, os títulos em aberto,
   o saldo de estoque e a EFD gerada com o que o contador do cliente entregou.
4. Critério de saída: duas apurações sem divergência não explicada e o contador do cliente de acordo.
