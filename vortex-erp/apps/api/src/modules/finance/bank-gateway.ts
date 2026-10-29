import { randomUUID } from 'node:crypto';
import { D } from '@vortex/money';

/**
 * Integração bancária (seção 13): registro de boleto via API (preferencial) ou
 * remessa CNAB, Pix cob/cobv com txid único por título, pagamentos de borderô.
 */
export interface BoletoRequest {
  bankCode: string;
  agreement: string;
  ourNumber: string;
  amount: string;
  dueDate: string;
  payer: { name: string; taxId: string };
  finePercent: string;
  interestMonthPercent: string;
  /** Boleto híbrido: inclui QR Code Pix */
  hybrid: boolean;
  pixKey?: string | null;
}

export interface PixRequest {
  txid: string;
  amount: string;
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  dueDate?: string | null;
  payer?: { name: string; taxId: string };
}

export interface PaymentOrder {
  method: 'pix' | 'ted' | 'boleto';
  amount: string;
  beneficiary: { name: string; taxId: string; bankCode?: string | null; branch?: string | null; account?: string | null; pixKey?: string | null };
  barcode?: string | null;
  reference: string;
}

export interface BankGateway {
  readonly name: string;
  registerBoleto(req: BoletoRequest): Promise<{ gatewayId: string; ourNumber: string; barcode: string; digitableLine: string; pixQrCode: string | null }>;
  createPix(req: PixRequest): Promise<{ gatewayId: string; txid: string; qrCode: string }>;
  cancelCharge(gatewayId: string): Promise<void>;
  sendPayment(order: PaymentOrder): Promise<{ status: 'sent' | 'confirmed' | 'failed'; bankReference: string; failureReason?: string }>;
}

// ------------------------------------------------------------------ boleto (FEBRABAN)

function mod10(num: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    let p = Number(num[i]) * weight;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    weight = weight === 2 ? 1 : 2;
  }
  const r = sum % 10;
  return r === 0 ? 0 : 10 - r;
}

function mod11Barcode(num: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    sum += Number(num[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const r = 11 - (sum % 11);
  return r === 0 || r === 10 || r === 11 ? 1 : r;
}

/** Fator de vencimento (base 07/10/1997; a partir de 22/02/2025 reinicia em 1000). */
export function dueFactor(dueDate: string): string {
  const base = Date.UTC(1997, 9, 7);
  const [y, m, d] = dueDate.split('-').map(Number);
  let days = Math.round((Date.UTC(y!, m! - 1, d!) - base) / 86_400_000);
  while (days > 9999) days -= 9000;
  return String(days).padStart(4, '0');
}

/** Código de barras (44) e linha digitável (47) a partir do campo livre de 25 posições. */
export function buildBoletoCodes(bankCode: string, dueDate: string, amount: string, freeField: string): { barcode: string; digitableLine: string } {
  if (freeField.length !== 25) throw new Error('Campo livre deve ter 25 posições');
  const value = D(amount).times(100).toFixed(0).padStart(10, '0');
  const partial = `${bankCode}9${dueFactor(dueDate)}${value}${freeField}`;
  const dv = mod11Barcode(partial);
  const barcode = `${bankCode}9${dv}${dueFactor(dueDate)}${value}${freeField}`;
  const f1 = `${bankCode}9${freeField.slice(0, 5)}`;
  const f2 = freeField.slice(5, 15);
  const f3 = freeField.slice(15, 25);
  const digitableLine = `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${dv}${dueFactor(dueDate)}${value}`;
  return { barcode, digitableLine };
}

export function validateDigitableLine(line: string): boolean {
  const l = line.replace(/\D/g, '');
  if (l.length !== 47) return false;
  const f1 = l.slice(0, 9), f2 = l.slice(10, 20), f3 = l.slice(21, 31);
  if (mod10(f1) !== Number(l[9]) || mod10(f2) !== Number(l[20]) || mod10(f3) !== Number(l[31])) return false;
  const barcode = `${l.slice(0, 4)}${l[32]}${l.slice(33, 47)}${l.slice(4, 9)}${l.slice(10, 20)}${l.slice(21, 31)}`;
  return mod11Barcode(barcode.slice(0, 4) + barcode.slice(5)) === Number(barcode[4]);
}

// ------------------------------------------------------------------ Pix BR Code (EMV MPM) com CRC16-CCITT

function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const emv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;
const ascii = (s: string, max: number) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, max);

/** BR Code com chave, valor e txid (campo 62-05), validável por qualquer app bancário. */
export function buildPixBrCode(p: { pixKey: string; amount: string; txid: string; merchantName: string; merchantCity: string }): string {
  const gui = emv('00', 'br.gov.bcb.pix') + emv('01', p.pixKey);
  const body =
    emv('00', '01') + emv('26', gui) + emv('52', '0000') + emv('53', '986') + emv('54', D(p.amount).toFixed(2)) + emv('58', 'BR') +
    emv('59', ascii(p.merchantName, 25)) + emv('60', ascii(p.merchantCity, 15)) + emv('62', emv('05', p.txid.slice(0, 25))) + '6304';
  return body + crc16(body);
}

export function validatePixBrCode(code: string): boolean {
  return crc16(code.slice(0, -4)) === code.slice(-4);
}

/** Txid único por título (26–35 caracteres alfanuméricos para cobv; até 25 no BR Code estático). */
export function newTxid(): string {
  return randomUUID().replace(/-/g, '').slice(0, 25).toUpperCase();
}

// ------------------------------------------------------------------ implementação simulada (homologação local)

export class SimulatedBankGateway implements BankGateway {
  readonly name = 'simulated';
  readonly charges = new Map<string, { kind: string; amount: string; cancelled?: boolean; ref: string }>();
  readonly payments: PaymentOrder[] = [];
  failPaymentsTo = new Set<string>();

  async registerBoleto(req: BoletoRequest) {
    const our = req.ourNumber.padStart(11, '0').slice(-11);
    const free = `${req.agreement.padStart(7, '0').slice(-7)}${our}${'0'.repeat(7)}`.slice(0, 25);
    const { barcode, digitableLine } = buildBoletoCodes(req.bankCode, req.dueDate, req.amount, free);
    const gatewayId = `bol_${randomUUID().slice(0, 12)}`;
    this.charges.set(gatewayId, { kind: 'boleto', amount: req.amount, ref: our });
    const pixQrCode = req.hybrid && req.pixKey ? buildPixBrCode({ pixKey: req.pixKey, amount: req.amount, txid: our, merchantName: 'VORTEX', merchantCity: 'BRASIL' }) : null;
    return { gatewayId, ourNumber: our, barcode, digitableLine, pixQrCode };
  }

  async createPix(req: PixRequest) {
    const gatewayId = `pix_${randomUUID().slice(0, 12)}`;
    this.charges.set(gatewayId, { kind: 'pix', amount: req.amount, ref: req.txid });
    return { gatewayId, txid: req.txid, qrCode: buildPixBrCode(req) };
  }

  async cancelCharge(gatewayId: string) {
    const c = this.charges.get(gatewayId);
    if (c) c.cancelled = true;
  }

  async sendPayment(order: PaymentOrder) {
    this.payments.push(order);
    if (this.failPaymentsTo.has(order.beneficiary.taxId)) return { status: 'failed' as const, bankReference: `ret_${this.payments.length}`, failureReason: 'Conta do favorecido inválida' };
    return { status: 'sent' as const, bankReference: `ret_${this.payments.length}` };
  }
}
