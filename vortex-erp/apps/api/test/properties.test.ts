import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { DEFAULT_POSTING_RULES, postEvent, reverseEntries } from '../src/modules/accounting/posting.js';
import { makeApp, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const today = () => new Date().toISOString().slice(0, 10);

/** Chaves de valor usadas por cada regra padrão (sem o prefixo de subtração). */
const KEYS = Object.fromEntries(
  Object.entries(DEFAULT_POSTING_RULES).map(([type, lines]) => [type, [...new Set(lines.flatMap((l) => l.amount.map((k) => k.replace(/^-/, ''))))]]),
);
const cents = fc.integer({ min: 0, max: 5_000_000 }).map((n) => (n / 100).toFixed(2));
const positive = fc.integer({ min: 1, max: 5_000_000 }).map((n) => (n / 100).toFixed(2));
const op = fc.oneof(
  fc.record({ kind: fc.constant('post' as const), type: fc.constantFrom(...Object.keys(KEYS)), values: fc.array(cents, { minLength: 30, maxLength: 30 }) }),
  fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }),
);

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
});
afterAll(async () => app.close());

describe('Propriedades com banco (seção 25)', () => {
  it('RN-CTB-01 débitos = créditos sob qualquer sequência de eventos e estornos', async () => {
    const origins: string[] = [];
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        for (const o of ops) {
          if (o.kind === 'post') {
            const originId = randomUUID();
            const amounts = Object.fromEntries(KEYS[o.type]!.map((k, i) => [k, o.values[i]!]));
            try {
              const id = await run((tx) => postEvent(tx, { type: o.type, companyId: t.companyId, date: today(), description: `prop ${o.type}`, originType: 'prop', originId, amounts }));
              if (id) origins.push(originId);
            } catch (e) {
              // Regra que não fecha para esses valores é recusada inteira, sem gravar nada
              expect((e as { code?: string }).code).toBe('ACCOUNTING_UNBALANCED');
              const n = await run((tx) => tx.one<{ n: string }>(`SELECT count(*) AS n FROM accounting.journal_entries WHERE origin_id = $1`, [originId]));
              expect(n.n).toBe('0');
            }
          } else if (origins.length) {
            const originId = origins[o.pick % origins.length]!;
            await run((tx) => reverseEntries(tx, 'prop', originId, today(), 'teste de propriedade'));
          }
        }
        return run(async (tx) => {
          const total = await tx.one<{ d: string; c: string }>(`SELECT coalesce(sum(debit), 0) AS d, coalesce(sum(credit), 0) AS c FROM accounting.journal_lines`);
          const unbalanced = await tx.query(`SELECT entry_id FROM accounting.journal_lines GROUP BY entry_id HAVING sum(debit) <> sum(credit) OR count(*) < 2`);
          // Origem estornada zera em todas as contas
          const residue = await tx.query(
            `SELECT e.origin_id, l.account_id FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id = e.id
              WHERE e.origin_type = 'prop' AND e.origin_id IN (SELECT origin_id FROM accounting.journal_entries WHERE reversal_of IS NOT NULL)
              GROUP BY e.origin_id, l.account_id HAVING sum(l.debit) <> sum(l.credit)`);
          return D(total.d).equals(D(total.c)) && unbalanced.length === 0 && residue.length === 0;
        });
      }),
      { numRuns: 20 },
    );
    expect(origins.length).toBeGreaterThan(20);
  });

  it('RN-CTB-01 o banco recusa no commit um lançamento desbalanceado gravado por fora da aplicação', async () => {
    await fc.assert(
      fc.asyncProperty(positive, positive, async (a, b) => {
        fc.pre(!D(a).equals(D(b)));
        const attempt = run(async (tx) => {
          const acc = await tx.query<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code IN ('1.1.3.01', '2.3.2') ORDER BY code`);
          const e = await tx.one<{ id: string }>(
            `INSERT INTO accounting.journal_entries (tenant_id, company_id, number, entry_date, description, event_type, origin_type)
             VALUES ($1,$2,core.next_counter($2,'journal'),$3,'fora da regra','prop','prop') RETURNING id`, [tx.tenantId, t.companyId, today()]);
          await tx.exec(`INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, credit, history) VALUES ($1,$2,$3,$4,0,'x'), ($1,$2,$5,0,$6,'x')`,
            [tx.tenantId, e.id, acc[0]!.id, a, acc[1]!.id, b]);
        });
        await expect(attempt).rejects.toThrow(/RN-CTB-01/);
      }),
      { numRuns: 10 },
    );
  });
});
