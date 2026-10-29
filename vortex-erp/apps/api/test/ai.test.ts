import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { emit } from '../src/core/outbox.js';
import { MemoryMessenger } from '../src/core/mailer.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { buildBoletoCodes, dueFactor } from '../src/modules/finance/bank-gateway.js';
import type { AiModel, AiRequest } from '../src/modules/ai/model.js';
import { redact, restore } from '../src/modules/ai/runtime.js';
import { dueDateFromFactor, parseDigitableLine } from '../src/modules/ai/documents.js';
import { periodFrom } from '../src/modules/ai/ask.js';
import { weeklyForecast } from '../src/modules/ai/forecast.js';
import { createUser, makeApp, makeCnpj, setupTenant, type Client, type TenantFixture } from './helpers.js';
import { supplierNfe } from './nfe-fixture.js';

// ------------------------------------------------------------------ modelo roteirizado (sem rede)

type Script = (req: AiRequest) => BetaMessage | Error;
class FakeAi implements AiModel {
  readonly provider = 'fake';
  readonly model = 'claude-opus-5-5';
  enabled = true;
  script: Script[] = [];
  requests: AiRequest[] = [];
  available() {
    return this.enabled;
  }
  async create(req: AiRequest) {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error('roteiro vazio');
    const r = next(req);
    if (r instanceof Error) throw r;
    return r;
  }
  reset(enabled = true) {
    this.enabled = enabled;
    this.script = [];
    this.requests = [];
  }
}
function message(content: unknown[], stop: string = 'end_turn'): BetaMessage {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}
const json = (o: unknown) => () => message([{ type: 'text', text: JSON.stringify(o) }]);
const text = (s: string) => () => message([{ type: 'text', text: s }]);
const toolUse = (name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => () => message([{ type: 'tool_use', id, name, input }], 'tool_use');
const reqText = (r: AiRequest) => JSON.stringify(r.messages);

// ------------------------------------------------------------------ cenário

const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const ai = new FakeAi();
let app: App;
let t: TenantFixture;
let financeiro: Client;
let contador: Client;
let gerente: Client;
let vendedor: Client;
let comprador: Client;
let customer: string;
let supplier: string;
const supplierCnpj = makeCnpj();
const p: Record<string, string> = {};
let accounts: Record<string, string>;
let cats: Record<string, string>;
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);

async function product(key: string, description: string, ncm: string, extra: Record<string, unknown> = {}) {
  const r = await t.admin.post('/v1/products', { sku: key, description, ncm, stockUnit: 'UN', saleUnit: 'UN', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  p[key] = r.body.id;
  return r.body.id as string;
}

beforeAll(async () => {
  app = await makeApp({ ai });
  t = await setupTenant(app);
  financeiro = await createUser(app, t, ['financeiro']);
  contador = await createUser(app, t, ['contador']);
  gerente = await createUser(app, t, ['gerente']);
  vendedor = await createUser(app, t, ['vendedor']);
  comprador = await createUser(app, t, ['comprador']);
  accounts = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.accounts`))).map((a) => [a.code, a.id]));
  cats = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.categories`))).map((a) => [a.code, a.id]));
  await run((tx) => tx.exec(`UPDATE finance.accounts SET pix_key = 'financeiro@loja.test' WHERE id = $1`, [accounts.BANCO]));
  customer = (await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Maria Cliente', roles: ['customer'], finalConsumer: true, addresses: ADDR,
    creditLimit: '50000', contacts: [{ name: 'Maria', whatsapp: '5581988887777', consents: { cobranca_whatsapp: true } }] })).body.id;
  supplier = (await t.admin.post('/v1/parties', { kind: 'PJ', taxId: supplierCnpj, legalName: 'Distribuidora de Bebidas SA', roles: ['supplier'], addresses: ADDR })).body.id;
  await product('REFRI-GUARANA', 'Refrigerante guaraná lata 350ml', '22021000');
  await product('AGUA-500', 'Água mineral sem gás 500ml', '21069090');
  await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true });
  const list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
  await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: p['REFRI-GUARANA'], price: '6.00' });
  await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p['REFRI-GUARANA']!, type: 'opening', quantity: '500', unitCost: '2.50', sourceType: 'test' }));
});
afterAll(async () => app.close());

// ------------------------------------------------------------------ regras da casa

describe('RN-IA-03: minimização de dados pessoais', () => {
  it('troca CPF, CNPJ, e-mail e telefone por marcadores estáveis e restaura na resposta', () => {
    const map = new Map<string, string>();
    const out = redact('Cliente 529.982.247-25 (maria@cliente.test, (81) 98888-7777) deve à 11.222.333/0001-81; de novo 529.982.247-25. Pedido 12345678901.', map);
    expect(out).toBe('Cliente [CPF_1] ([EMAIL_1], [TELEFONE_1]) deve à [CNPJ_1]; de novo [CPF_1]. Pedido 12345678901.');
    expect(restore('Falei com [CPF_1] em [EMAIL_1]', map)).toBe('Falei com 529.982.247-25 em maria@cliente.test');
  });
});

describe('Classificação fiscal assistida', () => {
  it('RN-GER-04 sem IA: sugere pelo produto semelhante já classificado; com IA: a regra valida o NCM e o cClassTrib contra as tabelas', async () => {
    ai.reset(false);
    const r = await gerente.post('/v1/ai/classify-product', { description: 'Refrigerante cola lata 350ml' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'ncm_classification', source: 'rules', status: 'pending' });
    expect(r.body.payload.suggestion.ncm).toBe('22021000');
    expect(r.body.payload.evidence[0].source).toBe('produto_semelhante');

    ai.reset();
    ai.script = [json({ ncm: '22021000', cest: null, cclasstrib: '000001', confidence: 93, rationale: 'Refrigerante: posição 2202' })];
    const r2 = await gerente.post('/v1/ai/classify-product', { description: 'Refrigerante cola lata 350ml' });
    expect(r2.body).toMatchObject({ source: 'ai', confidence: '93.00' });
    expect(r2.body.payload.suggestion).toMatchObject({ ncm: '22021000', cclasstrib: '000001' });
    // Saída estruturada com esquema estrito e esforço explícito
    expect(ai.requests[0]!.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });

    // NCM inexistente na tabela vigente: a regra descarta e a sugestão volta a ser a das evidências
    ai.script = [json({ ncm: '99999999', cest: null, cclasstrib: null, confidence: 99, rationale: 'chute' })];
    const r3 = await gerente.post('/v1/ai/classify-product', { description: 'Refrigerante cola lata 350ml' });
    expect(r3.body).toMatchObject({ source: 'rules' });
    expect(r3.body.payload.suggestion.ncm).toBe('22021000');
  });

  it('RN-IA-01 rascunho de um produto: só quem altera regra fiscal (contador) confirma; o produto é atualizado', async () => {
    ai.reset();
    ai.script = [json({ ncm: '22011000', cest: null, cclasstrib: '000001', confidence: 88, rationale: 'Água mineral sem adição de açúcar: 2201.10.00' })];
    const d = await gerente.post('/v1/ai/classify-product', { productId: p['AGUA-500'] });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.payload.current.ncm).toBe('21069090');
    // NCM fora das evidências e da busca: confiança limitada a 70
    expect(Number(d.body.confidence)).toBeLessThanOrEqual(70);
    expect((await gerente.post(`/v1/ai/drafts/${d.body.id}/confirm`)).status).toBe(403);
    const ok = await contador.post(`/v1/ai/drafts/${d.body.id}/confirm`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.result.data).toMatchObject({ ncm: '22011000', cclasstrib: '000001' });
    expect((await t.admin.get(`/v1/products/${p['AGUA-500']}`)).body.ncm).toBe('22011000');
    expect((await contador.post(`/v1/ai/drafts/${d.body.id}/confirm`)).status).toBe(409);
  });
});

describe('Leitura de documentos', () => {
  const due = day(12);
  const free = '1234567' + '00000012345' + '0000000';
  const codes = buildBoletoCodes('341', due, '1234.56', free);
  const formatted = `${codes.digitableLine.slice(0, 5)}.${codes.digitableLine.slice(5, 10)} ${codes.digitableLine.slice(10, 15)}.${codes.digitableLine.slice(15, 21)} `
    + `${codes.digitableLine.slice(21, 26)}.${codes.digitableLine.slice(26, 32)} ${codes.digitableLine[32]} ${codes.digitableLine.slice(33)}`;

  it('linha digitável: dígitos conferidos, valor e vencimento pelo fator (base 22/02/2025)', () => {
    expect(parseDigitableLine(formatted)).toMatchObject({ kind: 'bancario', bankCode: '341', amount: '1234.56', dueDate: due });
    expect(parseDigitableLine(`${formatted.slice(0, -1)}7`)).toBeNull();
    expect(dueDateFromFactor(dueFactor('2026-10-30'))).toBe('2026-10-30');
    expect(dueDateFromFactor('1000')).toBe('2025-02-22');
    // Arrecadação (concessionária): 4 blocos de 11 + DV módulo 10
    const mod10 = (n: string) => {
      let s = 0;
      let w = 2;
      for (let i = n.length - 1; i >= 0; i--) {
        const x = Number(n[i]) * w;
        s += x > 9 ? Math.floor(x / 10) + (x % 10) : x;
        w = w === 2 ? 1 : 2;
      }
      return (10 - (s % 10)) % 10;
    };
    const barcode = `8260${'00000012345'}${'0'.repeat(29)}`;
    const line = [0, 1, 2, 3].map((i) => barcode.slice(i * 11, i * 11 + 11)).map((b) => `${b}${mod10(b)}`).join('');
    expect(parseDigitableLine(line)).toMatchObject({ kind: 'arrecadacao', amount: '123.45' });
  });

  it('sem IA: boleto em texto vira rascunho com fornecedor, valor e vencimento; o financeiro confirma e o título nasce', async () => {
    ai.reset(false);
    const r = await financeiro.post('/v1/ai/read-document', { text: `Beneficiário: Distribuidora de Bebidas SA CNPJ ${supplierCnpj}\nPagador: Loja\nLinha digitável: ${formatted}` });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'payable_title', source: 'rules' });
    expect(r.body.payload).toMatchObject({ partyId: supplier, amount: '1234.56', dueDate: due, digitableLine: codes.digitableLine, missing: ['categoria'] });
    const c = await financeiro.post(`/v1/ai/drafts/${r.body.id}/confirm`, { overrides: { categoryId: cats['5.3'], documentNumber: 'BOL-7781' } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const title = (await financeiro.get(`/v1/finance/titles/${c.body.result.id}`)).body;
    expect(title).toMatchObject({ kind: 'payable', amount: '1234.56', due_date: due, digitable_line: codes.digitableLine, document_number: 'BOL-7781', party_id: supplier });
  });

  it('com IA (PDF): o modelo lê o documento, mas o código de barras manda no valor; categoria do histórico do fornecedor', async () => {
    ai.reset();
    ai.script = [json({ documentType: 'boleto', supplierName: 'Distribuidora de Bebidas', supplierTaxId: supplierCnpj, documentNumber: '000123', issueDate: today, dueDate: due,
      amount: '1243.56', digitableLine: '12345', description: 'Bebidas para revenda', categoryCode: '4.1' })];
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj << >> stream\nBT (Linha digitavel ${formatted}) Tj ET\nendstream\n%%EOF`);
    const r = await financeiro.post('/v1/ai/read-document', { fileBase64: pdf.toString('base64'), contentType: 'application/pdf', fileName: 'boleto.pdf' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.source).toBe('ai');
    expect(r.body.payload).toMatchObject({ amount: '1234.56', dueDate: due, partyId: supplier, categoryId: cats['5.3'], documentNumber: '000123' });
    expect(r.body.payload.divergences).toEqual(expect.arrayContaining([expect.stringContaining('não confere'), expect.stringContaining('difere do código de barras')]));
    // O PDF foi enviado como bloco de documento
    const content = ai.requests[0]!.messages[0]!.content as any[];
    expect(content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    expect((await financeiro.post(`/v1/ai/drafts/${r.body.id}/discard`)).body.status).toBe('discarded');
  });
});

describe('Perguntas em linguagem natural', () => {
  beforeAll(async () => {
    const o = await t.admin.post('/v1/sales/orders', { establishmentId: t.establishmentId, partyId: customer, items: [{ productId: p['REFRI-GUARANA'], quantity: 24 }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    expect(inv.body.transmission.status).toBe('autorizada');
  });

  it('períodos relativos em português', () => {
    const now = new Date('2026-10-22T15:00:00Z');
    expect(periodFrom('quanto vendi no mês passado?', now)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(periodFrom('vendas de agosto', now)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(periodFrom('vendas de dezembro', now)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodFrom('e hoje?', now)).toMatchObject({ from: '2026-10-22', to: '2026-10-22' });
  });

  it('sem IA: responde "quanto vendi de X" pelas regras, com o relatório de vendas', async () => {
    ai.reset(false);
    const r = await gerente.post('/v1/ai/ask', { question: 'Quanto vendi de refrigerante guaraná este mês na filial matriz?' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.source).toBe('rules');
    expect(r.body.answer).toContain('24 unidades de Refrigerante guaraná lata 350ml');
    expect(r.body.answer).toContain('R$ 144,00');
    expect((await vendedor.post('/v1/ai/ask', { question: 'Quanto vendi?' })).status).toBe(403);
  });

  it('com IA: laço de ferramentas de leitura; dados pessoais não vão ao modelo; uso registrado', async () => {
    ai.reset();
    ai.script = [
      toolUse('search_products', { query: 'guaraná' }),
      (req) => {
        const last = req.messages.at(-1)!.content as any[];
        expect(last[0]).toMatchObject({ type: 'tool_result' });
        expect(last[0].content).toContain('REFRI-GUARANA');
        return toolUse('run_report', { code: 'vendas.por_periodo', paramsJson: JSON.stringify({ from: day(-1), to: day(1), groupBy: 'product' }) })();
      },
      text('Você vendeu 24 unidades de Refrigerante guaraná (R$ 144,00) para [CPF_1].'),
    ];
    const r = await gerente.post('/v1/ai/ask', { question: 'Quanto a cliente 529.982.247-25 comprou de guaraná hoje?' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.source).toBe('ai');
    expect(r.body.toolCalls.map((c: any) => [c.name, c.ok])).toEqual([['search_products', true], ['run_report', true]]);
    // A resposta volta com o dado restaurado; o modelo só viu o marcador
    expect(r.body.answer).toContain('para 529.982.247-25');
    for (const req of ai.requests) expect(reqText(req)).not.toContain('529.982.247-25');
    expect(reqText(ai.requests[0]!)).toContain('[CPF_1]');
    // Ferramentas estritas e escolha automática (a escolha forçada não combina com o pensamento adaptativo)
    expect(ai.requests[0]!.tools!.every((x: any) => x.strict === true)).toBe(true);
    expect(ai.requests[0]!.tool_choice).toEqual({ type: 'auto' });
    const calls = await run((tx) => tx.query<{ feature: string; status: string; cost_usd: string; redactions: number }>(`SELECT feature, status, cost_usd, redactions FROM ai.calls WHERE feature = 'perguntas'`));
    expect(calls).toHaveLength(3);
    // 1000 tokens de entrada a US$ 4/MTok + 200 de saída a US$ 20/MTok
    expect(calls[0]).toMatchObject({ status: 'ok', cost_usd: '0.008000', redactions: 1 });
  });

  it('a ferramenta respeita as permissões do usuário: relatório sem permissão volta como erro para o modelo', async () => {
    ai.reset();
    ai.script = [toolUse('run_report', { code: 'vendas.por_periodo', paramsJson: JSON.stringify({ from: today, to: today }) }), text('Você não tem acesso a vendas.')];
    const r = await contador.post('/v1/ai/ask', { question: 'Quanto vendemos hoje?' });
    expect(r.body.toolCalls).toEqual([expect.objectContaining({ name: 'run_report', ok: false })]);
    const result = (ai.requests[1]!.messages.at(-1)!.content as any[])[0];
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toContain('vendas.pedido.ler');
  });

  it('fail-open: recusa ou erro do modelo cai nas regras e fica registrado', async () => {
    ai.reset();
    ai.script = [() => message([], 'refusal'), () => new Error('overloaded')];
    const r1 = await gerente.post('/v1/ai/ask', { question: 'Quanto vendi de guaraná este mês?' });
    expect(r1.body).toMatchObject({ source: 'rules' });
    expect(r1.body.answer).toContain('24 unidades');
    const r2 = await gerente.post('/v1/ai/ask', { question: 'Quanto vendi de guaraná este mês?' });
    expect(r2.body.source).toBe('rules');
    const st = await run((tx) => tx.query<{ status: string }>(`SELECT status FROM ai.calls WHERE feature = 'perguntas' ORDER BY created_at DESC LIMIT 2`));
    expect(st.map((s) => s.status).sort()).toEqual(['error', 'refused']);
  });

  it('RN-IA-03: outro tenant não enxerga os produtos deste', async () => {
    const t2 = await setupTenant(app);
    ai.reset();
    ai.script = [toolUse('search_products', { query: 'guaraná' }), text('Não encontrei.')];
    await t2.admin.post('/v1/ai/ask', { question: 'Quanto vendi de guaraná?' });
    expect((ai.requests[1]!.messages.at(-1)!.content as any[])[0].content).toBe('[]');
  });
});

describe('Agente de cobrança', () => {
  let titleId: string;
  beforeAll(async () => {
    const r = await t.admin.post('/v1/finance/titles', { kind: 'receivable', partyId: customer, documentNumber: 'DUP-900', issueDate: day(-70), installments: [{ dueDate: day(-40), amount: '1000.00' }],
      categoryId: cats['1.1'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    titleId = r.body[0].id;
  });

  it('proposta dentro dos limites: parcelas e desconto ajustados; Pix gerado; acordo aprovado vira renegociação', async () => {
    ai.reset(false);
    const r = await financeiro.post('/v1/ai/collection/negotiate', { partyId: customer, requested: { installments: 6, discountPercent: '10' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pl = r.body.payload;
    // Dívida: 1000 + multa 2% (CDC) + juros 1% a.m. pro rata (40 dias)
    expect(pl.charges).toBe(D('20.00').plus(D('1000').times('0.01').times(40).dividedBy(30).toDecimalPlaces(2)).toFixed(2));
    expect(pl.installments).toHaveLength(3);
    expect(pl.discount).toBe('0.00');
    expect(pl.adjustments).toEqual(['Parcelas limitadas a 3', 'Desconto só para pagamento à vista']);
    expect(D(pl.installments.reduce((a: any, i: any) => D(a).plus(i.amount), D(0))).toFixed(2)).toBe(pl.debt);
    expect(pl.pix.qrCode).toContain('br.gov.bcb.pix');
    expect(pl.reply).toContain('3 parcelas de');
    const c = await financeiro.post(`/v1/ai/drafts/${r.body.id}/confirm`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.result.data.titles).toHaveLength(3);
    expect((await financeiro.get(`/v1/finance/titles/${titleId}`)).body.status).toBe('renegotiated');
    const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
  });

  it('WhatsApp: o modelo interpreta o pedido, as regras limitam o desconto e a resposta vai com consentimento', async () => {
    const r0 = await t.admin.post('/v1/finance/titles', { kind: 'receivable', partyId: customer, documentNumber: 'DUP-901', issueDate: day(-40), installments: [{ dueDate: day(-10), amount: '500.00' }],
      categoryId: cats['1.1'] });
    expect(r0.status).toBe(201);
    ai.reset();
    ai.script = [json({ intent: 'propor', installments: 1, discountPercent: 20, firstDueInDays: 2, summary: 'Paga à vista com 20% de desconto' })];
    const r = await t.admin.post('/v1/ai/collection/whatsapp', { from: '+55 81 98888-7777', text: 'Oi, consigo pagar tudo depois de amanhã se tiver 20% de desconto' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pl = r.body.payload;
    expect(pl).toMatchObject({ intent: 'propor', discountPercent: '5.00', sentTo: '5581988887777' });
    expect(pl.titleIds).toHaveLength(4);
    expect(pl.installments).toEqual([{ dueDate: day(2), amount: pl.total }]);
    expect(pl.adjustments).toEqual(['Desconto limitado a 5,00%']);
    const sent = (app.deps.services.messenger as MemoryMessenger).sent.at(-1)!;
    expect(sent.text).toContain('pagamento à vista');
    expect(sent.text).toContain('Pix copia e cola');
    // O nome e o CPF do cliente não foram ao modelo
    expect(reqText(ai.requests[0]!)).not.toContain('Maria');
  });
});

describe('Previsão de demanda', () => {
  it('média móvel ponderada com sazonalidade do ano anterior', () => {
    expect(weeklyForecast(Array.from({ length: 10 }, () => 10), 4)).toEqual({ base: 10, seasonality: 1 });
    // Ano passado: as 4 semanas equivalentes venderam o dobro das 8 anteriores
    const weeks = Array.from({ length: 64 }, (_, i) => (i >= 48 && i < 52 ? 20 : 10));
    expect(weeklyForecast(weeks, 4)).toEqual({ base: 10, seasonality: 2 });
  });

  it('projeta pelo histórico de vendas e promoções; a confirmação gera o pedido de compra em rascunho', async () => {
    const cola = await product('COLA-2L', 'Refrigerante cola 2 litros', '22021000');
    await run(async (tx) => {
      await postMovement(tx, { warehouseId: t.warehouseId, productId: cola, type: 'opening', quantity: '400', unitCost: '5.00', sourceType: 'test', occurredAt: new Date(Date.now() - 70 * 86_400_000).toISOString() });
      for (let w = 1; w <= 8; w++) {
        await postMovement(tx, { warehouseId: t.warehouseId, productId: cola, type: 'sale_out', quantity: '30', sourceType: 'test', occurredAt: new Date(Date.now() - (w * 7 + 1) * 86_400_000).toISOString() });
      }
      await tx.exec(`INSERT INTO catalog.product_suppliers (tenant_id, product_id, supplier_id, supplier_code, factor, lead_time_days, last_price) VALUES ($1,$2,$3,'C2L','1',7,'5.20')`,
        [tx.tenantId, cola, supplier]);
    });
    ai.reset(false);
    const r = await comprador.post('/v1/ai/demand-forecast', { warehouseId: t.warehouseId, horizonDays: 28, promotions: [{ productId: cola, upliftPercent: '50' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const it = r.body.items.find((i: any) => i.productId === cola);
    // 30/semana × 1,5 (promoção) = 45/semana; demanda (28 + 7 dias) = 225 + segurança 45 − saldo 160
    expect(it).toMatchObject({ weeklyBase: '30.0000', seasonality: '1.0000', promotionUplift: '50.00', forecast: '180.0000', available: '160.0000', suggestedQuantity: '110.0000' });
    const c = await comprador.post(`/v1/ai/drafts/${r.body.draft.id}/confirm`, { overrides: { productIds: [cola] } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const order = c.body.result.data[0];
    expect(order).toMatchObject({ status: 'draft', supplier_id: supplier });
    expect(order.items[0]).toMatchObject({ product_id: cola, quantity: '110.0000' });
  });
});

describe('De-para inteligente', () => {
  it('o modelo escolhe entre candidatos do cadastro; escolha fora da lista é ignorada; a sugestão ainda precisa de confirmação', async () => {
    const nfe = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [
      { code: 'X-GUA', description: 'REFRIG GUARANA LT 350 CX C/12', ncm: '22021000', unit: 'CX', quantity: '10', unitPrice: '60.00' },
      { code: 'X-OUT', description: 'COPO DESCARTAVEL 200ML', ncm: '39241000', quantity: '5', unitPrice: '3.00' },
    ] });
    const rc = await t.admin.post('/v1/purchasing/receipts', { establishmentId: t.establishmentId, xml: nfe.xml });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    const items = rc.body.items as any[];
    const gua = items.find((i) => i.supplier_code === 'X-GUA');
    const out = items.find((i) => i.supplier_code === 'X-OUT');
    ai.reset();
    ai.script = [json({ matches: [
      { itemId: gua.id, productId: p['REFRI-GUARANA'], factor: '12', confidence: 90 },
      { itemId: out.id, productId: p['AGUA-500'], factor: '1', confidence: 80 },
    ] })];
    const r = await comprador.post(`/v1/ai/receipts/${rc.body.id}/suggest-matches`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items).toEqual([{ itemId: gua.id, productId: p['REFRI-GUARANA'], factor: '12', confidence: 90 }]);
    const after = (await t.admin.get(`/v1/purchasing/receipts/${rc.body.id}`)).body.items.find((i: any) => i.id === gua.id);
    expect(after).toMatchObject({ product_id: p['REFRI-GUARANA'], match_source: 'suggestion', stock_quantity: '120.0000' });
  });
});

describe('Detecção de anomalias', () => {
  it('conta bancária trocada com pagamento em aberto, nota inesperada e quebra de caixa recorrente; cada achado uma vez', async () => {
    await run(async (tx) => {
      // Fornecedor com conta antiga e uma nova solicitada agora, com título a pagar em aberto
      await tx.exec(`INSERT INTO registry.party_bank_accounts (tenant_id, party_id, bank_code, branch, account_number, holder_name, holder_tax_id, status, created_at)
                     VALUES ($1,$2,'001','1234','11111','Distribuidora de Bebidas SA',$3,'active', now() - interval '1 year')`, [tx.tenantId, supplier, supplierCnpj]);
      const acc = await tx.one<{ id: string }>(`INSERT INTO registry.party_bank_accounts (tenant_id, party_id, pix_key_type, pix_key, holder_name, holder_tax_id)
                     VALUES ($1,$2,'random','abc-123','Fulano de Tal','52998224725') RETURNING id`, [tx.tenantId, supplier]);
      await emit(tx, 'fornecedor.conta_bancaria_alterada', { type: 'party', id: supplier }, { partyId: supplier, bankAccountId: acc.id, holderDiffers: true });
      await tx.exec(`INSERT INTO fiscal.inbound_documents (tenant_id, company_id, establishment_id, access_key, issuer_tax_id, issuer_name, total)
                     VALUES ($1,$2,$3,$4,'11222333000181','Empresa Desconhecida LTDA',9800)`, [tx.tenantId, t.companyId, t.establishmentId, '2'.repeat(44)]);
      for (let i = 1; i <= 3; i++) {
        await tx.exec(`INSERT INTO integration.pdv_cash_movements (tenant_id, company_id, establishment_id, pdv_id, reference, kind, expected, counted, difference, cash_account_id, occurred_at)
                       VALUES ($1,$2,$3,'PDV-02',$4,'closing',500,480,-20,$5, now() - make_interval(days => $6))`, [tx.tenantId, t.companyId, t.establishmentId, `FECH-${i}`, accounts.CAIXA, i]);
      }
    });
    const r = await gerente.post('/v1/ai/anomalies/scan');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const kinds = r.body.map((a: any) => a.kind).sort();
    expect(kinds).toEqual(['conta_bancaria_fornecedor', 'nota_entrada_inesperada', 'quebra_de_caixa']);
    expect(r.body.find((a: any) => a.kind === 'conta_bancaria_fornecedor')).toMatchObject({ severity: 'critical' });
    expect(r.body.find((a: any) => a.kind === 'quebra_de_caixa').message).toContain('R$ 60,00');
    expect((await gerente.post('/v1/ai/anomalies/scan')).body).toHaveLength(0);
    const events = await run((tx) => tx.query(`SELECT 1 FROM integration.outbox_events WHERE event_type = 'ia.anomalia'`));
    expect(events).toHaveLength(3);
    const list = (await gerente.get('/v1/ai/anomalies', { status: 'open' })).body;
    expect((await gerente.patch(`/v1/ai/anomalies/${list[0].id}`, { status: 'resolved' })).body.status).toBe('resolved');
  });
});

describe('RN-IA-02: consumo registrado para o VORTEX Meter', () => {
  it('cada chamada tem tenant, usuário, tokens e custo; evento ia.consumo publicado', async () => {
    const usage = (await t.admin.get('/v1/ai/usage', { from: day(-1), to: day(1) })).body;
    const ask = usage.find((u: any) => u.feature === 'perguntas' && u.status === 'ok');
    expect(ask.calls).toBeGreaterThanOrEqual(3);
    expect(D(ask.cost_usd).greaterThan(0)).toBe(true);
    const users = await run((tx) => tx.query(`SELECT DISTINCT user_id FROM ai.calls WHERE status = 'ok' AND user_id IS NULL`));
    expect(users).toHaveLength(0);
    const ev = await run((tx) => tx.query<{ payload: any }>(`SELECT payload FROM integration.outbox_events WHERE event_type = 'ia.consumo' LIMIT 1`));
    expect(ev[0]!.payload).toMatchObject({ modelo: 'claude-opus-5-5', custoUsd: expect.any(String) });
    // Chamadas com a IA desligada não geram consumo
    const off = await run((tx) => tx.query(`SELECT 1 FROM ai.calls WHERE status = 'unavailable'`));
    const offEvents = await run((tx) => tx.query(`SELECT 1 FROM integration.outbox_events WHERE event_type = 'ia.consumo' AND payload->>'status' = 'unavailable'`));
    expect(off.length).toBeGreaterThan(0);
    expect(offEvents).toHaveLength(0);
  });
});

describe('Chat com a assistente: conversas, histórico e acesso de leitura a toda a operação', () => {
  it('sem IA responde a visão geral pelas regras; com IA usa as ferramentas e o histórico; conversa é só de quem criou', async () => {
    ai.reset(false);
    const first = await gerente.post('/v1/ai/chat', { message: 'Como está a operação?' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.message).toMatchObject({ role: 'assistant', source: 'rules', content: expect.stringContaining('Como está a operação') });
    const id = first.body.conversationId;
    expect((await gerente.get('/v1/ai/conversations')).body.map((c: any) => c.id)).toContain(id);

    ai.reset();
    ai.script = [toolUse('operation_overview', {}), (req) => {
      // A segunda rodada recebe o histórico da conversa e o resultado da ferramenta
      expect(reqText(req)).toContain('Como está a operação?');
      expect(reqText(req)).toContain('ordersByStage');
      return text('Há pedidos aguardando faturamento; o caixa está positivo.')();
    }];
    const second = await gerente.post('/v1/ai/chat', { conversationId: id, message: 'E o que eu faço primeiro?' });
    expect(second.body.message).toMatchObject({ source: 'ai', content: expect.stringContaining('aguardando faturamento') });
    expect(second.body.message.tool_calls).toEqual([expect.objectContaining({ name: 'operation_overview', ok: true })]);
    const conv = (await gerente.get(`/v1/ai/conversations/${id}`)).body;
    expect(conv.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    // Outra pessoa não vê nem apaga a conversa
    const outro = await createUser(app, t, ['gerente']);
    expect((await outro.get(`/v1/ai/conversations/${id}`)).status).toBe(404);
    expect((await outro.post('/v1/ai/chat', { conversationId: id, message: 'oi' })).status).toBe(404);
    expect((await gerente.del(`/v1/ai/conversations/${id}`)).status).toBe(200);
    expect((await gerente.get(`/v1/ai/conversations/${id}`)).status).toBe(404);
  });
});
