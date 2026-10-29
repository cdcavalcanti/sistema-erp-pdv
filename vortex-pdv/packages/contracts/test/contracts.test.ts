import { describe, expect, it } from 'vitest';
import { cep, cnpj, cpf, decimal, installPtBrMessages, partySchema, salesOrderSchema, uf } from '../src/index.js';

installPtBrMessages();

const UUID = '7f9d2c1e-3b4a-4c5d-8e6f-0a1b2c3d4e5f';

describe('Primitivas compartilhadas entre API e web', () => {
  it('decimal: aceita texto, vírgula e número; nunca devolve float', () => {
    expect(decimal().parse('10,50')).toBe('10.50');
    expect(decimal().parse(3)).toBe('3');
    expect(decimal().safeParse('1e3').success).toBe(false);
    expect(decimal().safeParse('abc').success).toBe(false);
    expect(decimal({ positive: true }).safeParse('0').success).toBe(false);
    expect(decimal({ min: 0 }).safeParse('-0.01').success).toBe(false);
  });

  it('documentos e endereço: limpa máscara e valida dígitos', () => {
    expect(cpf.parse('529.982.247-25')).toBe('52998224725');
    expect(cpf.safeParse('111.111.111-11').success).toBe(false);
    expect(cnpj.parse('11.222.333/0001-81')).toBe('11222333000181');
    expect(cnpj.safeParse('11.222.333/0001-82').success).toBe(false);
    expect(uf.parse('pe')).toBe('PE');
    expect(uf.safeParse('XX').success).toBe(false);
    expect(cep.parse('50050-000')).toBe('50050000');
  });

  it('pessoa e pedido: padrões e mensagens que a tela mostra', () => {
    const p = partySchema.parse({ kind: 'PF', legalName: 'Maria', roles: ['customer'] });
    expect(p).toMatchObject({ ieIndicator: 9, creditLimit: '0', addresses: [], contacts: [] });
    const o = salesOrderSchema.safeParse({ establishmentId: UUID, partyId: UUID, items: [] });
    expect(o.success).toBe(false);
    expect(o.error!.issues[0]!.message).toBe('Inclua ao menos um item');
    const bad = partySchema.safeParse({ kind: 'XX', legalName: 'a', roles: [], xmlEmail: 'nope' });
    expect(bad.error!.issues.map((i) => i.message)).toEqual([
      'Valor inválido; aceitos: PF, PJ, EX', 'Deve ter no mínimo 2 caractere(s)', 'Informe no mínimo 1 item(ns)', 'E-mail inválido',
    ]);
    expect(salesOrderSchema.safeParse({ establishmentId: 'x', partyId: UUID, items: [] }).error!.issues[0]!.message).toBe('Identificador (UUID) inválido');
    expect(partySchema.safeParse({ legalName: 'Maria', roles: ['customer'] }).error!.issues[0]!.message).toBe('Campo obrigatório');
    const ok = salesOrderSchema.parse({ establishmentId: UUID, partyId: UUID, items: [{ productId: UUID, quantity: '2,5' }] });
    expect(ok).toMatchObject({ channel: 'counter', operationTypeCode: 'VENDA', submit: true, items: [{ quantity: '2.5' }] });
  });
});
