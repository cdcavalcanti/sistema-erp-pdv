import pg from 'pg';

// NUMERIC e BIGINT ficam como texto (RN-GER-06: nunca ponto flutuante).
// DATE fica como texto 'YYYY-MM-DD' para não sofrer deslocamento de fuso.
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => {
    // Erro em conexão ociosa não deve derrubar o processo.
    console.error('[pg] erro em conexão ociosa', err.message);
  });
  return pool;
}
