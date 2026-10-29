export interface Operator {
  id: string;
  name: string;
  login: string;
  permissions: string[];
  roles: string[];
  discountLimitPercent: string;
}

export interface Item {
  id: string;
  seq: number;
  sku: string;
  description: string;
  unit: string;
  quantity: string;
  unit_price: string;
  base_price: string;
  gross: string;
  discount: string;
  total: string;
  status: 'active' | 'cancelled';
  cancel_reason?: string | null;
  /** Cancelamento parcial: item de onde estas unidades saíram */
  cancelled_from_seq?: number | null;
  weighed: number;
  promotions: { id: string; name: string }[];
  manualDiscount: { kind: 'percent' | 'value'; value: string } | null;
}

export interface Payment {
  id: string;
  method: 'cash' | 'pix' | 'debit' | 'credit' | 'pos_debit' | 'pos_credit';
  amount: string;
  tendered: string | null;
  change: string;
  installments: number;
  status: 'pending' | 'approved' | 'declined' | 'cancelled' | 'timeout' | 'refunded';
  transaction_id: string | null;
  qr_code: string | null;
  nsu: string | null;
  brand: string | null;
  message: string | null;
  expires_at: string | null;
}

export interface SaleView {
  sale: {
    id: string; number: string; status: 'open' | 'payment' | 'completed' | 'cancelled' | 'discarded'; subtotal: string; discount_total: string; total: string; change_total: string;
    paid_total: string; fiscal_status: string | null; customer: { id: string | null; name: string | null; taxIdMasked: string | null } | null;
    saleDiscount: { kind: string; value: string; amount: string } | null; created_at: string;
  };
  items: Item[];
  payments: Payment[];
  remaining: string;
  fiscal: { status: string; number: number; series: number; accessKey: string; protocol: string | null; emissionType: number; rejection: { code: string; message: string } | null } | null;
  warnings: string[];
  receipt?: string | null;
  printError?: string | null;
}

export interface CashSession {
  id: string;
  opened_at: string;
  opening_amount: string;
  status: 'open' | 'closed';
  operator_id: string;
}

export const can = (op: Operator | null | undefined, perm: string) => Boolean(op?.permissions.includes(perm));
