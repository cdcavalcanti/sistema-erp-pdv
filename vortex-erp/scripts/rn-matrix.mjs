#!/usr/bin/env node
/**
 * Matriz RN → testes (seção 25: cada regra de negócio tem pelo menos um teste com o código no nome).
 * Lê docs/rn-catalog.json (extraído do guia) e procura os códigos nos títulos de it()/describe()/it.each()
 * dos testes de todos os pacotes. `node scripts/rn-matrix.mjs` regrava docs/rn-matrix.md.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIRS = ['apps/api/test', 'apps/web/src', 'apps/web/e2e', 'packages/fiscal-engine/test', 'packages/money/test', 'packages/validators/test', 'packages/contracts/test'];

function walk(dir) {
  let out = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(test|spec)\.(ts|tsx)$/.test(e) || /golden\.cases\.ts$/.test(e)) out.push(p);
  }
  return out;
}

/** Títulos de teste (it/describe/test) e ids dos casos dourados, com os códigos RN que citam. */
export function collectTests() {
  const tests = [];
  for (const d of TEST_DIRS) {
    for (const file of walk(join(root, d))) {
      const src = readFileSync(file, 'utf8');
      const re = /(?:\b(?:it|test|describe)(?:\.each\([^)]*\))?\(\s*|title:\s*)(['"`])((?:\\.|(?!\1).)*)\1/g;
      for (const m of src.matchAll(re)) {
        const title = m[2];
        const codes = title.match(/RN-[A-Z]+-\d{2}/g) ?? [];
        if (codes.length) tests.push({ file: relative(root, file), title, codes });
      }
    }
  }
  return tests;
}

export function coverage() {
  const catalog = JSON.parse(readFileSync(join(root, 'docs/rn-catalog.json'), 'utf8'));
  const tests = collectTests();
  return catalog.map((r) => ({ ...r, tests: tests.filter((t) => t.codes.includes(r.code)) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cov = coverage();
  const missing = cov.filter((r) => !r.tests.length);
  const short = (s) => (s.length > 150 ? `${s.slice(0, 147)}…` : s).replace(/\|/g, '\\|');
  const md = [
    '# Matriz de regras de negócio × testes',
    '',
    'Gerada por `node scripts/rn-matrix.mjs` a partir de `docs/rn-catalog.json` (regras do guia de construção) e dos títulos dos testes.',
    'O teste `apps/api/test/rn-coverage.test.ts` falha se alguma regra ficar sem teste com o código no nome (seção 25).',
    '',
    `**${cov.length - missing.length} de ${cov.length} regras com teste.**`,
    '',
    '| Regra | Descrição | Testes |',
    '|---|---|---|',
    ...cov.map((r) => `| ${r.code} | ${short(r.rule)} | ${r.tests.length ? r.tests.map((t) => `\`${t.file.split('/').pop()}\`: ${short(t.title)}`).join('<br>') : '**sem teste**'} |`),
    '',
  ].join('\n');
  writeFileSync(join(root, 'docs/rn-matrix.md'), md);
  console.log(`docs/rn-matrix.md: ${cov.length - missing.length}/${cov.length} regras com teste${missing.length ? `; faltam ${missing.map((m) => m.code).join(', ')}` : ''}`);
}
