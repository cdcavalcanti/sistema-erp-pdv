import { D } from '@vortex/money';
import { pdvSettingsSchema, type PdvSettings } from '@vortex/contracts';
import type { LocalDb } from '../db/sqlite.js';
import type { Sealer } from '../security/crypto.js';
import { maskTaxId, normalize } from '../domain/text.js';

/**
 * Aplica a carga do ERP (GET /v1/pdv/sync) no banco local: produtos, códigos de barras,
 * preços, promoções, clientes, formas de pagamento, operadores, estoque, parâmetros e o
 * contexto fiscal da NFC-e. Delta por "since": só o que mudou desde a última carga.
 */
export function applySyncPayload(db: LocalDb, sealer: Sealer, p: Record<string, any>, at: string, opts: { full?: boolean; rebind?: boolean } = {}):
  { products: number; customers: number; operators: number; removedProducts: number; removedCustomers: number } {
  return db.tx(() => {
    let removedProducts = 0;
    let removedCustomers = 0;
    // Terminal ligado a outra loja/ERP: o que veio da carga anterior não vale mais (preços, estoque, clientes do ERP)
    if (opts.rebind) {
      db.run(`DELETE FROM prices`);
      db.run(`DELETE FROM stock`);
      db.run(`DELETE FROM price_lists`);
    }
    // Numeração já usada no ERP (terminal reinstalado/banco local novo): continua dela, sem repetir
    for (const n of p.numbering?.nfce ?? []) db.bumpCounter(`nfce:${n.environment}:${n.series}`, Number(n.lastNumber));
    for (const id of p.numbering?.lastSaleIds ?? []) {
      const m = /^PDV-\d+-(\d{8})-(\d+)$/.exec(String(id));
      if (m) db.bumpCounter(`sale:${m[1]}`, Number(m[2]));
    }
    for (const x of p.products ?? []) {
      db.run(
        `INSERT INTO products (id, sku, description, short_description, gtin, manufacturer_code, ncm, kind, sale_unit, stock_unit, controls_stock, allow_negative_stock, status, category_id, search, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET sku = excluded.sku, description = excluded.description, short_description = excluded.short_description, gtin = excluded.gtin,
           manufacturer_code = excluded.manufacturer_code, ncm = excluded.ncm, kind = excluded.kind, sale_unit = excluded.sale_unit, stock_unit = excluded.stock_unit,
           controls_stock = excluded.controls_stock, allow_negative_stock = excluded.allow_negative_stock, status = excluded.status, category_id = excluded.category_id,
           search = excluded.search, updated_at = excluded.updated_at`,
        [x.id, x.sku, x.description, x.short_description ?? null, x.gtin ?? null, x.manufacturer_code ?? null, x.ncm ?? null, x.kind, x.sale_unit, x.stock_unit,
          x.controls_stock === false ? 0 : 1, x.allow_negative_stock ? 1 : 0, x.status, x.category_id ?? null,
          normalize([x.sku, x.description, x.short_description, x.manufacturer_code].filter(Boolean).join(' ')), String(x.updated_at)]);
      db.run(`DELETE FROM barcodes WHERE product_id = ?`, [x.id]);
      if (x.gtin) db.run(`INSERT OR REPLACE INTO barcodes (code, product_id, unit, factor) VALUES (?,?,?,'1')`, [x.gtin, x.id, x.sale_unit]);
      for (const c of x.conversions ?? []) {
        if (c.gtin) db.run(`INSERT OR REPLACE INTO barcodes (code, product_id, unit, factor) VALUES (?,?,?,?)`, [c.gtin, x.id, c.unit, String(c.factor)]);
      }
    }
    for (const l of p.priceLists ?? []) {
      db.run(`INSERT OR REPLACE INTO price_lists (id, code, name, is_default, valid_from, valid_to, active) VALUES (?,?,?,?,?,?,?)`,
        [l.id, l.code, l.name, l.is_default ? 1 : 0, l.valid_from ? String(l.valid_from).slice(0, 10) : null, l.valid_to ? String(l.valid_to).slice(0, 10) : null, l.active ? 1 : 0]);
    }
    for (const i of p.prices ?? []) {
      db.run(`INSERT OR REPLACE INTO prices (price_list_id, product_id, min_qty, price) VALUES (?,?,?,?)`, [i.price_list_id, i.product_id, D(i.min_qty).toString(), D(i.price).toString()]);
    }
    // Promoções: a carga traz as vigentes; substitui o conjunto
    if (Array.isArray(p.promotions)) {
      db.run(`DELETE FROM promotions`);
      for (const pr of p.promotions) {
        db.run(`INSERT INTO promotions (id, data, starts_at, ends_at) VALUES (?,?,?,?)`, [pr.id, JSON.stringify(pr), new Date(pr.starts_at).toISOString(), new Date(pr.ends_at).toISOString()]);
      }
    }
    for (const c of p.customers ?? []) upsertCustomer(db, sealer, { id: c.id, kind: c.kind, name: c.legal_name, tradeName: c.trade_name, taxId: c.tax_id, status: c.status,
      blockReason: c.block_reason, priceListId: c.price_list_id, updatedAt: String(c.updated_at), pending: false });
    for (const m of p.paymentMethods ?? []) {
      db.run(`INSERT OR REPLACE INTO payment_methods (code, id, name, kind, nfe_tpag, active) VALUES (?,?,?,?,?,?)`, [m.code, m.id, m.name, m.kind, m.nfe_tpag, m.active ? 1 : 0]);
    }
    // Operadores: a lista vem completa; quem saiu do ERP perde acesso ao terminal
    if (Array.isArray(p.operators)) {
      db.run(`DELETE FROM operators`);
      for (const o of p.operators) {
        db.run(`INSERT INTO operators (id, name, login, pin_hash, permissions, roles, discount_limit_percent, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          [o.id, o.name, o.login, o.pin_hash, JSON.stringify(o.permissions ?? []), JSON.stringify(o.roles ?? []), D(o.discount_limit_percent ?? 0).toString(), o.updated_at ? String(o.updated_at) : null]);
      }
    }
    for (const s of p.stock ?? []) {
      db.run(`INSERT OR REPLACE INTO stock (product_id, warehouse_id, lot_id, quantity, reserved, blocked) VALUES (?,?,?,?,?,?)`,
        [s.product_id, s.warehouse_id, s.lot_id ?? '', D(s.quantity).toString(), D(s.reserved ?? 0).toString(), D(s.blocked ?? 0).toString()]);
    }
    if (Array.isArray(p.stockParams)) {
      db.run(`DELETE FROM stock_params`);
      for (const s of p.stockParams) db.run(`INSERT INTO stock_params (product_id, warehouse_id, reorder_point) VALUES (?,?,?)`, [s.product_id, s.warehouse_id, D(s.reorder_point).toString()]);
    }
    // Carga completa é a foto do catálogo: produto que não veio não existe mais no ERP (nem é vendido aqui)
    if (opts.full && Array.isArray(p.products)) {
      const ids = JSON.stringify(p.products.map((x: { id: string }) => x.id));
      removedProducts = db.run(`UPDATE products SET status = 'inactive' WHERE status <> 'inactive' AND id NOT IN (SELECT value FROM json_each(?))`, [ids]).changes;
      db.run(`DELETE FROM barcodes WHERE product_id NOT IN (SELECT value FROM json_each(?))`, [ids]);
    }
    if (opts.rebind && Array.isArray(p.customers)) {
      // Clientes do ERP anterior saem; os cadastrados no caixa e ainda não enviados ficam
      removedCustomers = db.run(`DELETE FROM customers WHERE pending = 0 AND id NOT IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(p.customers.map((x: { id: string }) => x.id))]).changes;
    }
    if (p.settings) db.setMeta('settings.erp', p.settings);
    if (p.fiscal) db.setMeta('fiscal.context', p.fiscal);
    if (p.establishment) db.setMeta('establishment', p.establishment);
    if (p.nfceSeries) db.setMeta('nfce.series', p.nfceSeries);
    if (p.terminal) db.setMeta('terminal', p.terminal);
    db.setMeta('sync.lastPullAt', at);
    db.setMeta('sync.cursor', p.serverTime ? new Date(p.serverTime).toISOString() : at);
    return { products: (p.products ?? []).length, customers: (p.customers ?? []).length, operators: (p.operators ?? []).length, removedProducts, removedCustomers };
  });
}

export interface LocalCustomer {
  id: string;
  kind: string;
  name: string;
  tradeName?: string | null;
  taxId?: string | null;
  status: string;
  blockReason?: string | null;
  priceListId?: string | null;
  updatedAt: string;
  pending: boolean;
}

export function upsertCustomer(db: LocalDb, sealer: Sealer, c: LocalCustomer): void {
  const tax = c.taxId ? c.taxId.replace(/\D/g, '') : null;
  if (tax) {
    // Mesmo documento com outro id (cadastrado aqui offline e também no ERP, ou cadastro unificado
    // no ERP): fica o id do ERP e as vendas que apontavam para o antigo passam a usá-lo
    const other = db.get<{ id: string }>(`SELECT id FROM customers WHERE tax_id_hash = ? AND id <> ?`, [sealer.lookupHash(tax), c.id]);
    if (other) {
      db.run(`DELETE FROM customers WHERE id = ?`, [other.id]);
      db.run(`UPDATE sales SET customer = json_set(customer, '$.id', ?) WHERE json_extract(customer, '$.id') = ?`, [c.id, other.id]);
    }
  }
  db.run(
    `INSERT INTO customers (id, kind, name, trade_name, tax_id_hash, tax_id_enc, tax_id_masked, status, block_reason, price_list_id, search, pending, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, trade_name = excluded.trade_name, tax_id_hash = excluded.tax_id_hash, tax_id_enc = excluded.tax_id_enc,
       tax_id_masked = excluded.tax_id_masked, status = excluded.status, block_reason = excluded.block_reason, price_list_id = excluded.price_list_id, search = excluded.search,
       pending = excluded.pending, updated_at = excluded.updated_at`,
    [c.id, c.kind, c.name, c.tradeName ?? null, tax ? sealer.lookupHash(tax) : null, tax ? sealer.seal(tax) : null, tax ? maskTaxId(tax) : null, c.status, c.blockReason ?? null,
      c.priceListId ?? null, normalize([c.name, c.tradeName].filter(Boolean).join(' ')), c.pending ? 1 : 0, c.updatedAt]);
}

// ------------------------------------------------------------------ parâmetros efetivos

const getPath = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o: any, path: string, v: unknown) {
  const ks = path.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks.at(-1)!] = v;
}

/** Parâmetros do ERP com os ajustes locais permitidos (seção 5: o gerente configura o que o ERP libera). */
export function effectiveSettings(db: LocalDb): PdvSettings {
  const base = pdvSettingsSchema.parse(db.meta('settings.erp') ?? {});
  const local = db.meta<Record<string, unknown>>('settings.local') ?? {};
  const merged = structuredClone(base) as any;
  for (const [path, value] of Object.entries(local)) if (base.localOverridable.includes(path)) setPath(merged, path, value);
  return pdvSettingsSchema.parse(merged);
}

export function setLocalSetting(db: LocalDb, path: string, value: unknown): PdvSettings {
  const base = pdvSettingsSchema.parse(db.meta('settings.erp') ?? {});
  if (!base.localOverridable.includes(path)) throw new Error(`Parâmetro ${path} não pode ser alterado no terminal (definido pelo ERP)`);
  const probe = structuredClone(base) as any;
  setPath(probe, path, value);
  pdvSettingsSchema.parse(probe);
  const local = db.meta<Record<string, unknown>>('settings.local') ?? {};
  local[path] = value;
  db.setMeta('settings.local', local);
  return effectiveSettings(db);
}

export { getPath };
