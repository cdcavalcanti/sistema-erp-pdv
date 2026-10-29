import { D, roundUnit } from '@vortex/money';
import { bestPromotion, promotionRuleSchema, type PromotionCandidate } from '@vortex/pricing';
import type { PdvSettings } from '@vortex/contracts';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import { parseScan } from '../domain/barcode.js';
import { normalize } from '../domain/text.js';
import { stockStatus, type StockStatus } from '../domain/stock.js';

export interface ProductRow {
  id: string;
  sku: string;
  description: string;
  short_description: string | null;
  gtin: string | null;
  manufacturer_code: string | null;
  ncm: string | null;
  kind: string;
  sale_unit: string;
  stock_unit: string;
  controls_stock: number;
  allow_negative_stock: number;
  status: string;
  category_id: string | null;
}

export interface ProductView {
  id: string;
  sku: string;
  description: string;
  gtin: string | null;
  reference: string | null;
  unit: string;
  weighable: boolean;
  price: string;
  basePrice: string;
  promotions: { id: string; name: string }[];
  available: string | null;
  stockStatus: StockStatus;
}

/** Unidades de produto pesável (quantidade decimal, balança) */
const WEIGHT_UNITS = new Set(['KG', 'G', 'GR']);

export interface Lookup {
  product: ProductRow;
  /** Quantidade sugerida pela leitura (fator da embalagem ou peso da etiqueta) */
  quantity: string | null;
  /** Preço total da etiqueta de balança (o preço/kg vem da lista) */
  labelPrice: string | null;
  barcode: string | null;
}

/**
 * Catálogo local (seções 9 a 12, 36): busca por código de barras, SKU, código interno, nome,
 * descrição e referência; etiqueta de balança; preço pela lista do cliente ou padrão com a
 * promoção mais vantajosa (mesma regra do ERP, @vortex/pricing); situação de estoque.
 */
export class CatalogService {
  constructor(private readonly db: LocalDb, private readonly clock: Clock, private readonly settings: () => PdvSettings, private readonly establishmentId: () => string) {}

  product(id: string): ProductRow | undefined {
    return this.db.get<ProductRow>(`SELECT * FROM products WHERE id = ?`, [id]);
  }

  /** Leitura do scanner ou digitação: GTIN (inclusive de embalagem), etiqueta de balança, SKU ou referência. */
  lookup(input: string): Lookup | null {
    const scan = parseScan(input, this.settings().scale);
    if (scan.kind === 'scale') {
      // PLU da balança = código interno (SKU numérico)
      const p = this.db.get<ProductRow>(`SELECT * FROM products WHERE ltrim(sku, '0') = ? ORDER BY status = 'active' DESC LIMIT 1`, [scan.plu]);
      if (!p) return null;
      if (scan.weight) return { product: p, quantity: scan.weight.toFixed(3), labelPrice: null, barcode: scan.raw };
      const unitPrice = this.priceFor(p.id, '1', null).price;
      const qty = D(unitPrice).isZero() ? null : scan.price!.dividedBy(unitPrice).toDecimalPlaces(3).toFixed(3);
      return { product: p, quantity: qty, labelPrice: scan.price!.toFixed(2), barcode: scan.raw };
    }
    const code = scan.code;
    const bc = this.db.get<{ product_id: string; factor: string }>(`SELECT product_id, factor FROM barcodes WHERE code = ?`, [code]);
    if (bc) return { product: this.product(bc.product_id)!, quantity: D(bc.factor).equals(1) ? null : D(bc.factor).toString(), labelPrice: null, barcode: code };
    const p = this.db.get<ProductRow>(`SELECT * FROM products WHERE sku = ? COLLATE NOCASE OR manufacturer_code = ? COLLATE NOCASE ORDER BY status = 'active' DESC LIMIT 1`, [code, code]);
    return p ? { product: p, quantity: null, labelPrice: null, barcode: null } : null;
  }

  /** Busca por nome/descrição/referência/SKU (todas as palavras). */
  search(q: string, limit = 30, customerPriceListId: string | null = null): ProductView[] {
    const words = normalize(q).split(' ').filter(Boolean).slice(0, 6);
    if (!words.length) return [];
    const where = words.map(() => `search LIKE ?`).join(' AND ');
    const rows = this.db.all<ProductRow>(`SELECT * FROM products WHERE status = 'active' AND ${where} ORDER BY description LIMIT ?`, [...words.map((w) => `%${w}%`), limit]);
    return rows.map((r) => this.view(r, '1', customerPriceListId));
  }

  view(p: ProductRow, quantity: string, customerPriceListId: string | null): ProductView {
    const price = this.priceFor(p.id, quantity, customerPriceListId);
    const available = this.available(p.id);
    return {
      id: p.id, sku: p.sku, description: p.description, gtin: p.gtin, reference: p.manufacturer_code, unit: p.sale_unit, weighable: this.weighable(p),
      price: price.price, basePrice: price.basePrice, promotions: price.promotions, available: p.controls_stock ? available : null,
      stockStatus: stockStatus({ productStatus: p.status, controlsStock: Boolean(p.controls_stock), available, reorderPoint: this.reorderPoint(p.id), lowThreshold: this.settings().stock.lowStockThreshold }),
    };
  }

  weighable(p: Pick<ProductRow, 'sale_unit'>): boolean {
    return WEIGHT_UNITS.has(p.sale_unit.toUpperCase());
  }

  /** Preço: lista do cliente → lista padrão (vigentes), maior faixa de quantidade atingida, melhor promoção. */
  priceFor(productId: string, quantity: string, customerPriceListId: string | null): { price: string; basePrice: string; promotions: { id: string; name: string }[] } {
    const today = new Date(this.clock.now().getTime() - 180 * 60_000).toISOString().slice(0, 10);
    const lists = [customerPriceListId, ...this.db.all<{ id: string }>(
      `SELECT id FROM price_lists WHERE is_default = 1 AND active = 1 AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)`, [today, today]).map((l) => l.id)].filter(Boolean) as string[];
    let base: string | null = null;
    for (const l of lists) {
      const row = this.db.all<{ price: string; min_qty: string }>(`SELECT price, min_qty FROM prices WHERE price_list_id = ? AND product_id = ?`, [l, productId])
        .filter((r) => D(r.min_qty).lessThanOrEqualTo(quantity)).sort((a, b) => D(b.min_qty).comparedTo(D(a.min_qty)))[0];
      if (row) {
        base = row.price;
        break;
      }
    }
    if (base === null) return { price: '0', basePrice: '0', promotions: [] };
    const best = bestPromotion(D(base), D(quantity), this.promotionsFor(productId));
    return { price: best.unitPrice.toString(), basePrice: roundUnit(D(base)).toString(), promotions: best.applied };
  }

  private promotionsFor(productId: string): PromotionCandidate[] {
    const now = this.clock.now().toISOString();
    const p = this.product(productId);
    const est = this.establishmentId();
    return this.db.all<{ data: string }>(`SELECT data FROM promotions WHERE starts_at <= ? AND ends_at > ?`, [now, now])
      .map((r) => JSON.parse(r.data) as Record<string, any>)
      .filter((x) => x.active !== false)
      .filter((x) => (!x.product_ids?.length && !x.category_ids?.length) || x.product_ids?.includes(productId) || (p?.category_id && x.category_ids?.includes(p.category_id)))
      .filter((x) => !x.channels?.length || x.channels.includes('pdv'))
      .filter((x) => !x.establishment_ids?.length || x.establishment_ids.includes(est))
      .flatMap((x) => {
        const rule = promotionRuleSchema.safeParse(x.rule);
        return rule.success ? [{ id: x.id, name: x.name, rule: rule.data, cumulative: Boolean(x.cumulative),
          remaining: x.max_quantity === null || x.max_quantity === undefined ? null : D(x.max_quantity).minus(x.used_quantity ?? 0) }] : [];
      });
  }

  /**
   * Disponível local: saldo do ERP menos reservado e bloqueado, menos as vendas deste terminal
   * que o ERP ainda não refletiu (não sincronizadas ou sincronizadas depois da última carga).
   */
  available(productId: string): string | null {
    const rows = this.db.all<{ quantity: string; reserved: string; blocked: string }>(`SELECT quantity, reserved, blocked FROM stock WHERE product_id = ?`, [productId]);
    // Sem linha de saldo depois de uma carga: o produto nunca teve entrada no ERP (saldo zero), não "desconhecido"
    if (!rows.length && !this.db.meta<string>('sync.lastPullAt')) return null;
    const erp = rows.reduce((a, r) => a.plus(r.quantity).minus(r.reserved).minus(r.blocked), D(0));
    const lastPull = this.db.meta<string>('sync.lastPullAt') ?? '1970-01-01';
    const sold = this.db.all<{ quantity: string }>(
      `SELECT i.quantity FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE i.product_id = ? AND i.status = 'active' AND s.status = 'completed' AND (s.sync_status <> 'synced' OR s.synced_at > ?)`, [productId, lastPull]);
    return sold.reduce((a, r) => a.minus(r.quantity), erp).toDecimalPlaces(4).toString();
  }

  reorderPoint(productId: string): string | null {
    const rows = this.db.all<{ reorder_point: string }>(`SELECT reorder_point FROM stock_params WHERE product_id = ?`, [productId]);
    return rows.length ? rows.map((r) => D(r.reorder_point)).reduce((a, b) => (b.greaterThan(a) ? b : a)).toString() : null;
  }
}
