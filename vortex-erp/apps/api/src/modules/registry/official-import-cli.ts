import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../config.js';
import { fetchIbgeCities, importOfficial, type OfficialTable } from './official-import.js';

// Uso: pnpm fiscal:import <ncm|cest|cfop|cclasstrib|ibge_cities|nbs|service_codes> <arquivo.json> [vigencia AAAA-MM-DD]
//      pnpm fiscal:import ibge_cities --ibge   (baixa da API oficial do IBGE)
const [table, file, validFrom] = process.argv.slice(2) as [OfficialTable, string, string | undefined];
if (!table || !file) {
  console.error('Uso: fiscal:import <tabela> <arquivo.json|--ibge> [vigência]');
  process.exit(1);
}
const cfg = loadConfig();
const rows = file === '--ibge' ? await fetchIbgeCities() : JSON.parse(await readFile(file, 'utf8'));
const r = await importOfficial(cfg.databaseOwnerUrl, table, rows, validFrom);
console.log(`✓ ${r.table}: ${r.inserted} inseridos, ${r.updated} atualizados, ${r.closed} vigências encerradas`);
