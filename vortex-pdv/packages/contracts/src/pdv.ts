import { z } from 'zod';
import { decimal } from './primitives.js';

/**
 * Contratos da integração Vortex ERP ⇄ Vortex PDV. O ERP valida o que recebe e o PDV
 * valida o que envia com os mesmos esquemas. Endpoints conceituais da especificação do
 * PDV (seção 33) mapeados para a API real do ERP:
 *
 *   GET  /products, /customers      → GET  /v1/pdv/sync (carga e delta por "since")
 *   POST /customers                 → POST /v1/parties
 *   POST /sales, POST /sync         → POST /v1/pdv/sales (idempotente)
 *   GET  /sales/:id                 → GET  /v1/pdv/sales/:saleId
 *   POST /sales/:id/cancel          → POST /v1/pdv/sales/cancel
 *   POST /cash/open|supply|withdraw|close → POST /v1/pdv/cash-movements (kind)
 *   GET  /sync/status               → GET  /v1/pdv/sync/status
 */

const ts = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
/** Terminal na loja: "03" em PDV-03-20261027-000124 */
export const terminalCode = z.string().regex(/^[0-9]{2,3}$/, 'Código do terminal com 2 ou 3 dígitos');
/** Identificação do terminal nos payloads (o código do terminal; aceita identificadores legados) */
const pdvId = z.string().min(1).max(40);

// ------------------------------------------------------------------ parâmetros da loja

export const pdvSettingsSchema = z.object({
  cash: z.object({
    /** Conta financeira do tipo caixa onde o dinheiro do PDV entra */
    cashAccountId: uuid.nullable().default(null),
    /** Cofre/banco: origem do suprimento e destino da sangria */
    vaultAccountId: uuid.nullable().default(null),
    /** Acima deste valor em dinheiro na gaveta o PDV pede sangria */
    maxCashInDrawer: decimal({ min: 0 }).default('1000.00'),
    withdrawalRequiresSupervisor: z.boolean().default(true),
    /** Fechamento cego: o operador informa os valores sem ver o esperado */
    blindClosing: z.boolean().default(true),
  }).prefault({}),
  stock: z.object({
    /** Venda de produto sem estoque: permitir, avisar ou bloquear */
    outOfStock: z.enum(['allow', 'warn', 'block']).default('warn'),
    lowStockThreshold: decimal({ min: 0 }).default('5'),
  }).prefault({}),
  sale: z.object({
    itemCancelRequiresAuthorization: z.boolean().default(false),
    /** Prazo para cancelar a NFC-e (minutos após a autorização) */
    cancelWindowMinutes: z.number().int().min(1).max(1440).default(30),
    /** Valor a partir do qual a NFC-e exige identificar o consumidor */
    customerRequiredAbove: decimal({ min: 0 }).default('10000.00'),
    allowOffline: z.boolean().default(true),
    /** Tempo máximo vendendo offline antes de bloquear novas vendas */
    offlineMaxHours: z.number().int().min(1).max(168).default(24),
  }).prefault({}),
  payments: z.object({
    /** Códigos das formas de pagamento do ERP usadas pelo PDV */
    cash: z.string().default('DINHEIRO'),
    pix: z.string().default('PIX'),
    debit: z.string().default('DEBITO'),
    credit: z.string().default('CREDITO'),
    maxInstallments: z.number().int().min(1).max(24).default(12),
    minInstallmentValue: decimal({ min: 0 }).default('10.00'),
    pixTimeoutSeconds: z.number().int().min(30).max(1800).default(300),
  }).prefault({}),
  fiscal: z.object({
    /** Emissão offline (tpEmis 9) quando a SEFAZ não responde; transmitida depois em até 24 h */
    contingencyAllowed: z.boolean().default(true),
  }).prefault({}),
  receipt: z.object({
    header: z.string().max(200).default(''),
    footer: z.string().max(200).default('Obrigado pela preferência!'),
    columns: z.union([z.literal(32), z.literal(42), z.literal(48)]).default(48),
  }).prefault({}),
  scale: z.object({
    /** Etiqueta de balança EAN-13: prefixo, dígitos do código do produto e se o campo traz preço ou peso */
    prefixes: z.array(z.string().regex(/^2[0-9]?$/)).default(['2']),
    pluDigits: z.union([z.literal(4), z.literal(5), z.literal(6)]).default(5),
    valueKind: z.enum(['price', 'weight']).default('price'),
  }).prefault({}),
  session: z.object({
    idleMinutes: z.number().int().min(1).max(240).default(15),
    maxHours: z.number().int().min(1).max(24).default(12),
  }).prefault({}),
  /** Caminhos que o gerente pode alterar no terminal (seção 5: "parâmetros permitidos pelo ERP") */
  localOverridable: z.array(z.string()).default(['receipt.footer', 'receipt.columns', 'session.idleMinutes']),
});
export type PdvSettings = z.infer<typeof pdvSettingsSchema>;

// ------------------------------------------------------------------ PDV → ERP

export const pdvSaleSchema = z.object({
  establishmentId: uuid,
  warehouseId: uuid.nullish(),
  pdvId,
  /** Número da venda: PDV-03-20261027-000124 */
  saleId: z.string().min(1).max(80),
  saleUuid: uuid.optional(),
  sessionId: z.string().max(80).nullish(),
  occurredAt: ts,
  operator: z.string().nullish(),
  operatorId: uuid.nullish(),
  cashAccountId: uuid.nullish(),
  customer: z.object({ partyId: uuid.nullish(), taxId: z.string().nullish(), name: z.string().nullish() }).nullish(),
  items: z.array(z.object({
    productId: uuid, quantity: decimal({ positive: true }), unitPrice: decimal({ min: 0 }), discount: decimal({ min: 0 }).optional(), lotId: uuid.nullish(),
  })).min(1),
  payments: z.array(z.object({
    methodCode: z.string(), amount: decimal({ positive: true }), change: decimal({ min: 0 }).optional(),
    /** Identificador da transação no provedor (Pix txid, NSU do TEF): nunca dados do cartão */
    transactionId: z.string().max(120).nullish(),
    card: z.object({ nsu: z.string().optional(), authorization: z.string().optional(), brand: z.string().optional(), installments: z.number().int().min(1).max(24).optional() }).nullish(),
  })).min(1),
  nfce: z.object({ accessKey: z.string().length(44), status: z.enum(['autorizada', 'contingencia']), protocol: z.string().nullish(), authorizedAt: ts.nullish(), xml: z.string().nullish() }),
  /** Itens (ou unidades) cancelados no caixa antes de concluir a venda: não entram na NFC-e, ficam para auditoria */
  cancelledItems: z.array(z.object({
    productId: uuid, sku: z.string().max(60).nullish(), description: z.string().max(200), quantity: decimal({ positive: true }), unit: z.string().max(6).nullish(),
    unitPrice: decimal({ min: 0 }), reason: z.string().max(200), operatorId: uuid.nullish(), authorizedBy: uuid.nullish(), at: ts.nullish(), partial: z.boolean().optional(),
  })).max(500).optional(),
});
export type PdvSaleInput = z.input<typeof pdvSaleSchema>;

export const pdvSaleCancelSchema = z.object({
  establishmentId: uuid, pdvId, saleId: z.string().min(1).max(80),
  reason: z.string().min(15, 'Justificativa com no mínimo 15 caracteres').max(255),
  /** Protocolo do evento de cancelamento da NFC-e na SEFAZ */
  protocol: z.string().min(5),
  cancelledAt: ts,
  operatorId: uuid.nullish(), authorizedBy: uuid.nullish(),
});

export const pdvReturnSchema = z.object({
  establishmentId: uuid, pdvId,
  /** Identificador da devolução no terminal (idempotência) */
  reference: z.string().min(1).max(80),
  saleId: z.string().min(1).max(80),
  items: z.array(z.object({ itemNumber: z.number().int().min(1), quantity: decimal({ positive: true }) })).min(1),
  reason: z.string().min(5).max(255),
  refundMethod: z.enum(['cash', 'pix', 'card', 'store_credit']),
  /** Venda sem cliente identificado: quem devolve informa nome e CPF (a nota de entrada exige destinatário) */
  customer: z.object({ taxId: z.string().min(11).max(18), name: z.string().min(2).max(120) }).nullish(),
  destination: z.enum(['normal', 'damaged', 'discard']).default('normal'),
  occurredAt: ts,
  operatorId: uuid.nullish(), authorizedBy: uuid.nullish(),
});

export const pdvCashMovementSchema = z.object({
  establishmentId: uuid, pdvId,
  reference: z.string().min(1).max(80),
  kind: z.enum(['opening', 'supply', 'withdrawal', 'closing', 'reopening']),
  sessionId: z.string().max(80).nullish(),
  amount: decimal({ min: 0 }).optional(),
  /** Fechamento: dinheiro contado na gaveta */
  counted: decimal({ min: 0 }).optional(),
  cashAccountId: uuid.optional(),
  counterpartAccountId: uuid.nullish(),
  reason: z.string().max(255).nullish(),
  /** Fechamento: totais por forma (Pix, cartões) e conferência informada pelo operador */
  details: z.record(z.string(), z.unknown()).optional(),
  operatorId: uuid.nullish(), authorizedBy: uuid.nullish(),
  occurredAt: ts,
});

export const pdvHeartbeatSchema = z.object({
  appVersion: z.string().max(40),
  lastSyncAt: ts.nullish(),
  pendingSales: z.number().int().min(0),
  health: z.object({
    erp: z.enum(['online', 'offline']).optional(),
    fiscal: z.enum(['online', 'contingency', 'offline', 'error']).optional(),
    payment: z.enum(['online', 'offline', 'error']).optional(),
    printer: z.enum(['ok', 'paper_low', 'paper_out', 'offline', 'error']).optional(),
    localDb: z.enum(['ok', 'error']).optional(),
    fiscalFailures: z.number().int().min(0).optional(),
    paymentFailures: z.number().int().min(0).optional(),
    syncFailures: z.number().int().min(0).optional(),
    avgSaleSeconds: z.number().min(0).optional(),
    lastErrors: z.array(z.string().max(300)).max(10).optional(),
    openSession: z.object({ sessionId: z.string(), operatorId: uuid.nullish(), openedAt: ts }).nullish(),
  }).default({}),
});

export const pdvOperatorSchema = z.object({
  pdvLogin: z.string().regex(/^[0-9A-Za-z]{2,12}$/, 'Login com 2 a 12 letras ou números'),
  /** PIN numérico de 6 dígitos (login rápido e offline no terminal) */
  pin: z.string().regex(/^[0-9]{6}$/, 'PIN com 6 dígitos'),
});
