# ADR-0006 — Emissão por parceiro (FiscalGateway)

**Status:** aceito

## Contexto
Falar diretamente com 27 SEFAZ (webservices, contingência, certificados, NT novas a
cada trimestre) é um produto à parte. O guia recomenda um parceiro emissor no MVP (seção 09).

## Decisão
- A interface `FiscalGateway` tem duas implementações: `PartnerFiscalGateway` (HTTP para
  o parceiro, com token no cofre) e `SimulatedFiscalGateway` (autoriza, rejeita e entra em
  contingência de forma determinística, para desenvolvimento e testes).
- O ERP gera o documento, valida, numera e guarda o XML imutável (RN-NFE-08). O gateway
  só transmite, consulta e devolve o protocolo.
- O ambiente vem de `SEFAZ_AMBIENTE` (2 = homologação por padrão).

## Consequências
- Trocar de parceiro ou passar a falar direto com a SEFAZ é uma implementação nova da interface.
- A homologação real nas 3 UFs (seção 25) segue o roteiro em `docs/operacao.md`.
