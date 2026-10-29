import pg from 'pg';

/**
 * Carga e atualização das tabelas oficiais com vigência (seção 05).
 * Roda com a credencial do dono do schema (as tabelas oficiais são globais e
 * somente leitura para a aplicação).
 */
export type OfficialTable = 'ncm' | 'cest' | 'cfop' | 'cclasstrib' | 'ibge_cities' | 'nbs' | 'service_codes';

export interface ImportResult {
  table: OfficialTable;
  inserted: number;
  updated: number;
  closed: number;
}

/**
 * NCM e cClassTrib têm histórico: se a descrição/tratamento muda, a versão
 * anterior é encerrada na véspera e uma nova vigência começa (RN-GER-03).
 */
export async function importOfficial(ownerUrl: string, table: OfficialTable, rows: Record<string, any>[], validFrom = new Date().toISOString().slice(0, 10)): Promise<ImportResult> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  const res: ImportResult = { table, inserted: 0, updated: 0, closed: 0 };
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      switch (table) {
        case 'ncm': {
          const code = String(r.code ?? r.codigo).replace(/\D/g, '');
          if (code.length !== 8) continue;
          const desc = String(r.description ?? r.descricao);
          const cur = await c.query(`SELECT description, valid_from FROM fiscal.ncm WHERE code = $1 AND valid_to IS NULL`, [code]);
          if (cur.rows[0]?.description === desc) continue;
          if (cur.rows[0]) {
            await c.query(`UPDATE fiscal.ncm SET valid_to = $2::date - 1 WHERE code = $1 AND valid_to IS NULL`, [code, validFrom]);
            res.closed++;
          }
          await c.query(`INSERT INTO fiscal.ncm (code, description, valid_from, ipi_rate) VALUES ($1,$2,$3,$4) ON CONFLICT (code, valid_from) DO UPDATE SET description = EXCLUDED.description`,
            [code, desc, cur.rows[0] ? validFrom : (r.validFrom ?? '2017-01-01'), r.ipiRate ?? null]);
          res.inserted++;
          break;
        }
        case 'cclasstrib': {
          const code = String(r.code ?? r.cClassTrib);
          const cur = await c.query(`SELECT cst, reduction_ibs, reduction_cbs, description FROM fiscal.cclasstrib WHERE code = $1 AND valid_to IS NULL`, [code]);
          const same = cur.rows[0] && cur.rows[0].cst === String(r.cst) && Number(cur.rows[0].reduction_ibs) === Number(r.reductionIbs ?? 0)
            && Number(cur.rows[0].reduction_cbs) === Number(r.reductionCbs ?? 0) && cur.rows[0].description === r.description;
          if (same) continue;
          if (cur.rows[0]) {
            await c.query(`UPDATE fiscal.cclasstrib SET valid_to = $2::date - 1 WHERE code = $1 AND valid_to IS NULL`, [code, validFrom]);
            res.closed++;
          }
          await c.query(
            `INSERT INTO fiscal.cclasstrib (code, cst, description, reduction_ibs, reduction_cbs, presumed_credit, deferral, exempt, legal_basis, valid_from)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (code, valid_from) DO NOTHING`,
            [code, String(r.cst), r.description, r.reductionIbs ?? 0, r.reductionCbs ?? 0, Boolean(r.presumedCredit), Boolean(r.deferral), Boolean(r.exempt), r.legalBasis ?? null, cur.rows[0] ? validFrom : (r.validFrom ?? '2026-01-01')]);
          res.inserted++;
          break;
        }
        case 'ibge_cities': {
          const q = await c.query(`INSERT INTO fiscal.ibge_cities (code, name, uf) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, uf = EXCLUDED.uf RETURNING (xmax = 0) AS ins`,
            [String(r.code), r.name, r.uf]);
          if (q.rows[0]?.ins) res.inserted++;
          else res.updated++;
          break;
        }
        case 'cest':
          await c.query(`INSERT INTO fiscal.cest (code, description, segment, ncm_prefixes) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, ncm_prefixes = EXCLUDED.ncm_prefixes`,
            [String(r.code).replace(/\D/g, ''), r.description, r.segment ?? null, r.ncmPrefixes ?? []]);
          res.inserted++;
          break;
        case 'cfop':
          await c.query(`INSERT INTO fiscal.cfop (code, description, is_return) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
            [String(r.code), r.description, Boolean(r.isReturn)]);
          res.inserted++;
          break;
        case 'nbs':
          await c.query(`INSERT INTO fiscal.nbs (code, description) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`, [String(r.code), r.description]);
          res.inserted++;
          break;
        case 'service_codes':
          await c.query(`INSERT INTO fiscal.service_codes (code, description) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`, [String(r.code), r.description]);
          res.inserted++;
          break;
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
  return res;
}

/** Busca municípios na API oficial do IBGE. */
export async function fetchIbgeCities(): Promise<{ code: string; name: string; uf: string }[]> {
  const r = await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/municipios', { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`IBGE indisponível (HTTP ${r.status})`);
  const data = (await r.json()) as any[];
  return data.map((m) => ({
    code: String(m.id),
    name: m.nome,
    uf: m.microrregiao?.mesorregiao?.UF?.sigla ?? m['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla,
  }));
}
