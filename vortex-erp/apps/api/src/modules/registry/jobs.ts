import { registerSystemJob } from '../../worker/registry.js';
import { fetchIbgeCities, importOfficial } from './official-import.js';

/**
 * Atualização periódica das tabelas oficiais. Municípios vêm da API do IBGE;
 * NCM e cClassTrib vêm de URLs configuradas (arquivos JSON publicados a partir
 * do Portal NF-e/Siscomex), porque essas fontes não têm API estável.
 */
registerSystemJob('tabelas_oficiais.atualizar', async (deps) => {
  const owner = deps.config.databaseOwnerUrl;
  const out: Record<string, unknown> = {};
  out.ibge = await importOfficial(owner, 'ibge_cities', await fetchIbgeCities());
  for (const [table, env] of [['ncm', 'NCM_SOURCE_URL'], ['cclasstrib', 'CCLASSTRIB_SOURCE_URL'], ['cest', 'CEST_SOURCE_URL']] as const) {
    const url = process.env[env];
    if (!url) continue;
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status}`);
    out[table] = await importOfficial(owner, table, (await r.json()) as Record<string, unknown>[]);
  }
  return out;
});
