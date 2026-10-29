import { describe, expect, it } from 'vitest';
// @ts-expect-error script JavaScript sem tipos
import { coverage } from '../../../scripts/rn-matrix.mjs';

describe('Seção 25: cada regra de negócio do guia tem teste com o código no nome', () => {
  it('nenhuma RN- sem teste', () => {
    const cov = coverage() as { code: string; tests: unknown[] }[];
    expect(cov.length).toBeGreaterThanOrEqual(89);
    expect(cov.filter((r) => r.tests.length === 0).map((r) => r.code)).toEqual([]);
  });
});
