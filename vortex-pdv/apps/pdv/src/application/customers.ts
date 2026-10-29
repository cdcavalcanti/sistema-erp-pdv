import { isValidCNPJ, isValidCPF } from '@vortex/validators';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { Sealer } from '../security/crypto.js';
import type { SyncQueue } from '../sync/queue.js';
import type { ErpClient } from '../erp/client.js';
import { invalid } from '../domain/errors.js';
import { uuid } from '../domain/ids.js';
import { normalize } from '../domain/text.js';
import { upsertCustomer } from '../sync/catalog.js';

export interface CustomerView {
  id: string;
  name: string;
  taxIdMasked: string | null;
  status: string;
  blockReason: string | null;
  priceListId: string | null;
  pending: boolean;
}

interface CustomerRow {
  id: string;
  name: string;
  tax_id_masked: string | null;
  tax_id_enc: string | null;
  status: string;
  block_reason: string | null;
  price_list_id: string | null;
  pending: number;
}

const view = (r: CustomerRow): CustomerView => ({
  id: r.id, name: r.name, taxIdMasked: r.tax_id_masked, status: r.status, blockReason: r.block_reason, priceListId: r.price_list_id, pending: Boolean(r.pending),
});

/**
 * Cliente na venda (seção 14): consumidor final, pesquisa (local e, com conexão, no ERP) e
 * cadastro mínimo (nome, CPF/CNPJ, contato) enviado ao ERP pela fila. Não duplica o cadastro
 * completo do ERP. O documento fica cifrado no banco local; a busca usa hash com chave.
 */
export class CustomerService {
  constructor(private readonly db: LocalDb, private readonly sealer: Sealer, private readonly clock: Clock, private readonly queue: SyncQueue, private readonly erp: ErpClient) {}

  get(id: string): CustomerRow | undefined {
    return this.db.get<CustomerRow>(`SELECT * FROM customers WHERE id = ?`, [id]);
  }

  taxIdOf(id: string): string | null {
    const r = this.get(id);
    return r?.tax_id_enc ? this.sealer.open(r.tax_id_enc) : null;
  }

  async search(q: string, online: boolean): Promise<CustomerView[]> {
    const digits = q.replace(/\D/g, '');
    let rows: CustomerRow[];
    if (digits.length === 11 || digits.length === 14) {
      rows = this.db.all<CustomerRow>(`SELECT * FROM customers WHERE tax_id_hash = ?`, [this.sealer.lookupHash(digits)]);
    } else {
      const words = normalize(q).split(' ').filter(Boolean);
      rows = words.length ? this.db.all<CustomerRow>(`SELECT * FROM customers WHERE ${words.map(() => 'search LIKE ?').join(' AND ')} ORDER BY name LIMIT 20`, words.map((w) => `%${w}%`)) : [];
    }
    // Não achou localmente: consulta o ERP (cliente cadastrado depois da última carga)
    if (!rows.length && online && q.trim().length >= 3) {
      try {
        for (const c of await this.erp.searchCustomers(digits.length >= 11 ? digits : q)) {
          upsertCustomer(this.db, this.sealer, { id: c.id, kind: c.kind, name: c.legal_name, tradeName: c.trade_name, taxId: c.tax_id, status: c.status,
            blockReason: c.block_reason ?? null, priceListId: c.price_list_id ?? null, updatedAt: String(c.updated_at ?? this.clock.now().toISOString()), pending: false });
        }
        return this.search(q, false);
      } catch {
        // ERP fora do ar: segue só com o cache local
      }
    }
    return rows.map(view);
  }

  /** Cadastro rápido: vale na hora (offline inclusive) e vai ao ERP pela fila. */
  create(input: { taxId: string; name: string; email?: string | null; phone?: string | null }): CustomerView {
    const taxId = input.taxId.replace(/\D/g, '');
    const kind = taxId.length === 11 ? 'PF' : 'PJ';
    if (kind === 'PF' ? !isValidCPF(taxId) : !isValidCNPJ(taxId)) throw invalid('CPF/CNPJ inválido');
    if (!input.name || input.name.trim().length < 2) throw invalid('Informe o nome do cliente');
    const existing = this.db.get<CustomerRow>(`SELECT * FROM customers WHERE tax_id_hash = ?`, [this.sealer.lookupHash(taxId)]);
    if (existing) return view(existing);
    const id = uuid();
    return this.db.tx(() => {
      upsertCustomer(this.db, this.sealer, { id, kind, name: input.name.trim(), taxId, status: 'active', updatedAt: this.clock.now().toISOString(), pending: true });
      this.queue.enqueue('customer', 'customer', id, { kind, taxId: this.sealer.seal(taxId), legalName: input.name.trim(), email: input.email ?? null, phone: input.phone ?? null });
      return view(this.get(id)!);
    });
  }

  /** Confirmação do ERP: o cliente local passa a usar o id do ERP. */
  confirmed(localId: string, erpId: string): void {
    if (localId === erpId) return;
    this.db.tx(() => {
      const dup = this.get(erpId);
      if (dup) this.db.run(`DELETE FROM customers WHERE id = ?`, [localId]);
      else this.db.run(`UPDATE customers SET id = ?, pending = 0 WHERE id = ?`, [erpId, localId]);
      this.db.run(`UPDATE sales SET customer = json_set(customer, '$.id', ?) WHERE json_extract(customer, '$.id') = ?`, [erpId, localId]);
    });
  }
}
