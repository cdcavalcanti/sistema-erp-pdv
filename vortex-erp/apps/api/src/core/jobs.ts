import type { Tx } from '../db/tx.js';

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  queue?: string;
  maxAttempts?: number;
}

/** Enfileira um job na mesma transação do fato que o originou. */
export async function enqueue(tx: Tx, name: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<string | null> {
  const row = await tx.maybeOne<{ id: string }>(
    `INSERT INTO integration.jobs (tenant_id, queue, name, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, name, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running','failed') DO NOTHING
     RETURNING id`,
    [tx.tenantId, opts.queue ?? 'default', name, JSON.stringify(payload), opts.runAt ?? new Date(), opts.dedupeKey ?? null, opts.maxAttempts ?? 8],
  );
  return row?.id ?? null;
}
