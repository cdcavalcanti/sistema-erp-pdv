import { D } from '@vortex/money';

/** Situação de estoque (seção 36) e o que fazer com ela, conforme o ERP configurou. */
export type StockStatus = 'available' | 'low' | 'out' | 'blocked';

export function stockStatus(p: { productStatus: string; controlsStock: boolean; available: string | null; reorderPoint: string | null; lowThreshold: string }): StockStatus {
  if (p.productStatus !== 'active') return 'blocked';
  if (!p.controlsStock || p.available === null) return 'available';
  const a = D(p.available);
  if (a.lessThanOrEqualTo(0)) return 'out';
  const low = p.reorderPoint && D(p.reorderPoint).greaterThan(0) ? D(p.reorderPoint) : D(p.lowThreshold);
  return a.lessThanOrEqualTo(low) ? 'low' : 'available';
}

export type StockDecision = { action: 'allow' } | { action: 'warn'; message: string } | { action: 'block'; message: string };

export function stockDecision(status: StockStatus, policy: 'allow' | 'warn' | 'block', p: { available: string | null; requested: string; allowNegative: boolean; description: string }): StockDecision {
  if (status === 'blocked') return { action: 'block', message: `${p.description}: produto bloqueado no ERP` };
  const short = p.available !== null && D(p.available).lessThan(p.requested);
  if (!short || p.allowNegative || policy === 'allow') {
    return status === 'low' ? { action: 'warn', message: `${p.description}: estoque baixo` } : { action: 'allow' };
  }
  const msg = `${p.description}: sem estoque suficiente (disponível ${D(p.available ?? 0).toString()})`;
  return policy === 'block' ? { action: 'block', message: msg } : { action: 'warn', message: msg };
}
