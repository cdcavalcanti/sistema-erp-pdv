import type { Tx } from '../../db/tx.js';
import { createDefaultPostingRules } from '../accounting/posting.js';

/**
 * Padrões de implantação: o que todo tenant novo recebe para começar a operar
 * (configurar antes de customizar — RN-GER-09). Tudo pode ser alterado depois.
 */
export async function createTenantDefaults(tx: Tx): Promise<void> {
  const t = tx.tenantId;
  // ---------------------------------------------------------------- plano de contas contábil (simplificado, com referencial)
  const coa: [string, string, string, 'D' | 'C', boolean, boolean, string | null][] = [
    // código, nome, natureza, saldo, analítica, aceita manual, referencial RFB
    ['1', 'ATIVO', 'asset', 'D', false, false, '1'],
    ['1.1', 'ATIVO CIRCULANTE', 'asset', 'D', false, false, '1.01'],
    ['1.1.1', 'Disponível', 'asset', 'D', false, false, '1.01.01'],
    ['1.1.1.01', 'Caixa', 'asset', 'D', true, true, '1.01.01.01.01'],
    ['1.1.1.02', 'Bancos conta movimento', 'asset', 'D', true, true, '1.01.01.02.01'],
    ['1.1.2', 'Clientes', 'asset', 'D', false, false, '1.01.02'],
    ['1.1.2.01', 'Duplicatas a receber', 'asset', 'D', true, false, '1.01.02.01.01'],
    ['1.1.2.02', 'Cartões a receber (adquirentes)', 'asset', 'D', true, false, '1.01.02.01.01'],
    ['1.1.3', 'Estoques', 'asset', 'D', false, false, '1.01.03'],
    ['1.1.3.01', 'Mercadorias para revenda', 'asset', 'D', true, false, '1.01.03.01.01'],
    ['1.1.4', 'Tributos a recuperar', 'asset', 'D', false, false, '1.01.04'],
    ['1.1.4.01', 'ICMS a recuperar', 'asset', 'D', true, false, '1.01.04.01.01'],
    ['1.1.4.02', 'PIS/Cofins a recuperar', 'asset', 'D', true, false, '1.01.04.01.02'],
    ['1.1.4.03', 'IBS/CBS a recuperar', 'asset', 'D', true, false, '1.01.04.01.03'],
    ['1.1.4.04', 'Tributos retidos por clientes a compensar', 'asset', 'D', true, false, '1.01.04.01.04'],
    ['1.1.5', 'Adiantamentos a fornecedores', 'asset', 'D', true, true, '1.01.05.01.01'],
    ['2', 'PASSIVO', 'liability', 'C', false, false, '2'],
    ['2.1', 'PASSIVO CIRCULANTE', 'liability', 'C', false, false, '2.01'],
    ['2.1.1', 'Fornecedores', 'liability', 'C', true, false, '2.01.01.01.01'],
    ['2.1.2', 'Obrigações tributárias', 'liability', 'C', false, false, '2.01.02'],
    ['2.1.2.01', 'ICMS a recolher', 'liability', 'C', true, false, '2.01.02.01.01'],
    ['2.1.2.02', 'PIS/Cofins a recolher', 'liability', 'C', true, false, '2.01.02.01.02'],
    ['2.1.2.03', 'Simples Nacional a recolher', 'liability', 'C', true, false, '2.01.02.01.03'],
    ['2.1.2.04', 'IBS/CBS a recolher', 'liability', 'C', true, false, '2.01.02.01.04'],
    ['2.1.2.05', 'ISS e tributos retidos a recolher', 'liability', 'C', true, false, '2.01.02.01.05'],
    ['2.1.2.06', 'IPI a recolher', 'liability', 'C', true, false, '2.01.02.01.06'],
    ['2.1.2.07', 'ICMS-ST a recolher', 'liability', 'C', true, false, '2.01.02.01.07'],
    ['2.1.2.08', 'IRRF e contribuições retidos a recolher', 'liability', 'C', true, false, '2.01.02.01.08'],
    ['2.1.2.09', 'INSS retido a recolher', 'liability', 'C', true, false, '2.01.02.01.09'],
    ['2.1.3', 'Adiantamentos de clientes', 'liability', 'C', true, true, '2.01.03.01.01'],
    ['2.1.4', 'Comissões a pagar', 'liability', 'C', true, false, '2.01.04.01.01'],
    ['2.1.5', 'Obrigações trabalhistas', 'liability', 'C', false, false, '2.01.05'],
    ['2.1.5.01', 'Salários a pagar', 'liability', 'C', true, false, '2.01.05.01.01'],
    ['2.1.5.02', 'INSS a recolher', 'liability', 'C', true, false, '2.01.05.01.02'],
    ['2.1.5.03', 'FGTS a recolher', 'liability', 'C', true, false, '2.01.05.01.03'],
    ['2.1.5.04', 'IRRF sobre salários a recolher', 'liability', 'C', true, false, '2.01.05.01.04'],
    ['2.3', 'PATRIMÔNIO LÍQUIDO', 'equity', 'C', false, false, '2.03'],
    ['2.3.1', 'Capital social', 'equity', 'C', true, true, '2.03.01.01.01'],
    ['2.3.2', 'Lucros ou prejuízos acumulados', 'equity', 'C', true, true, '2.03.04.01.01'],
    ['3', 'RECEITAS', 'revenue', 'C', false, false, '3'],
    ['3.1', 'Receita bruta de vendas', 'revenue', 'C', true, false, '3.01.01.01.01'],
    ['3.2', 'Receita de serviços', 'revenue', 'C', true, false, '3.01.01.01.02'],
    ['3.3', 'Deduções da receita', 'revenue', 'D', false, false, '3.01.01.03'],
    ['3.3.1', 'Devoluções de vendas', 'revenue', 'D', true, false, '3.01.01.03.01'],
    ['3.3.2', 'Tributos sobre vendas', 'revenue', 'D', true, false, '3.01.01.03.02'],
    ['3.3.3', 'Descontos incondicionais', 'revenue', 'D', true, false, '3.01.01.03.03'],
    ['3.4', 'Receitas financeiras', 'revenue', 'C', true, true, '3.11.01.01.01'],
    ['4', 'CUSTOS E DESPESAS', 'expense', 'D', false, false, '4'],
    ['4.1', 'Custo das mercadorias vendidas', 'expense', 'D', true, false, '3.03.01.01.01'],
    ['4.2', 'Despesas com vendas', 'expense', 'D', false, false, '3.05'],
    ['4.2.1', 'Comissões sobre vendas', 'expense', 'D', true, false, '3.05.01.01.01'],
    ['4.2.2', 'Taxas de cartão', 'expense', 'D', true, false, '3.05.01.01.02'],
    ['4.2.3', 'Perdas de estoque', 'expense', 'D', true, false, '3.05.01.01.03'],
    ['4.3', 'Despesas administrativas', 'expense', 'D', true, true, '3.07.01.01.01'],
    ['4.4', 'Despesas financeiras', 'expense', 'D', false, false, '3.11.01.02'],
    ['4.4.1', 'Juros e multas pagos', 'expense', 'D', true, true, '3.11.01.02.01'],
    ['4.4.2', 'Descontos concedidos', 'expense', 'D', true, true, '3.11.01.02.02'],
    ['4.4.3', 'Tarifas bancárias', 'expense', 'D', true, true, '3.11.01.02.03'],
    ['4.5', 'Despesas com pessoal', 'expense', 'D', true, false, '3.07.01.02.01'],
  ];
  const coaIds = new Map<string, string>();
  for (const [code, name, nature, side, analytic, manual, ref] of coa) {
    const parentCode = code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : null;
    const row = await tx.one<{ id: string }>(
      `INSERT INTO accounting.chart_of_accounts (tenant_id, code, name, parent_id, nature, balance_side, is_analytic, accepts_manual, referential_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [t, code, name, parentCode ? coaIds.get(parentCode) ?? null : null, nature, side, analytic, manual, ref]);
    coaIds.set(code, row.id);
  }

  // ---------------------------------------------------------------- categorias gerenciais (DRE)
  const cats: [string, string, string, string, string][] = [
    ['1', 'Receita de vendas', 'revenue', 'receita_bruta', '3.1'],
    ['1.1', 'Receita de serviços', 'revenue', 'receita_bruta', '3.2'],
    ['2', 'Impostos sobre vendas', 'deduction', 'deducoes', '3.3.2'],
    ['2.1', 'Devoluções', 'deduction', 'deducoes', '3.3.1'],
    ['3', 'Custo das mercadorias vendidas', 'cost', 'cmv', '4.1'],
    ['4', 'Comissões', 'expense', 'despesas_vendas', '4.2.1'],
    ['4.1', 'Taxas de cartão', 'expense', 'despesas_vendas', '4.2.2'],
    ['4.2', 'Perdas de estoque', 'expense', 'despesas_vendas', '4.2.3'],
    ['5', 'Despesas administrativas', 'expense', 'despesas_administrativas', '4.3'],
    ['5.1', 'Aluguel', 'expense', 'despesas_administrativas', '4.3'],
    ['5.2', 'Folha de pagamento', 'expense', 'despesas_administrativas', '4.3'],
    ['5.3', 'Fornecedores diversos', 'expense', 'despesas_administrativas', '4.3'],
    ['6', 'Receitas financeiras', 'financial_revenue', 'resultado_financeiro', '3.4'],
    ['7', 'Despesas financeiras', 'financial_expense', 'resultado_financeiro', '4.4.1'],
    ['7.1', 'Descontos concedidos', 'financial_expense', 'resultado_financeiro', '4.4.2'],
    ['7.2', 'Tarifas bancárias', 'financial_expense', 'resultado_financeiro', '4.4.3'],
    ['8', 'Compras de mercadorias', 'cost', 'compras', '1.1.3.01'],
    ['9', 'Transferências entre contas', 'transfer', 'transferencias', '1.1.1.02'],
  ];
  const catIds = new Map<string, string>();
  for (const [code, name, kind, group, ledger] of cats) {
    const parentCode = code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : null;
    const row = await tx.one<{ id: string }>(
      `INSERT INTO finance.categories (tenant_id, code, name, parent_id, kind, dre_group, ledger_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [t, code, name, parentCode ? catIds.get(parentCode) ?? null : null, kind, group, coaIds.get(ledger) ?? null]);
    catIds.set(code, row.id);
  }
  await tx.exec(`INSERT INTO finance.cost_centers (tenant_id, code, name) VALUES ($1,'GERAL','Geral'), ($1,'VENDAS','Comercial'), ($1,'ADM','Administrativo')`, [t]);

  // ---------------------------------------------------------------- condições de pagamento
  const terms: [string, string, { days: number; percent: string }[], boolean][] = [
    ['AVISTA', 'À vista', [{ days: 0, percent: '100' }], true],
    ['30', '30 dias', [{ days: 30, percent: '100' }], false],
    ['30/60', '30/60 dias', [{ days: 30, percent: '50' }, { days: 60, percent: '50' }], false],
    ['30/60/90', '30/60/90 dias', [{ days: 30, percent: '33.3333' }, { days: 60, percent: '33.3333' }, { days: 90, percent: '33.3334' }], false],
  ];
  for (const [code, name, inst, cash] of terms) {
    await tx.exec(`INSERT INTO registry.payment_terms (tenant_id, code, name, installments, is_cash) VALUES ($1,$2,$3,$4,$5)`, [t, code, name, JSON.stringify(inst), cash]);
  }

  // ---------------------------------------------------------------- tipos de operação (naturezas)
  const ops: [string, string, 'S' | 'E', string, number, boolean, string, boolean, boolean, string | null, string | null][] = [
    // código, nome, direção, finalidade, finNFe, movEstoque, alvo, financeiro, fiscal, CFOP interno, CFOP interestadual
    ['VENDA', 'Venda de mercadoria', 'S', 'sale', 1, true, 'own', true, true, '5102', '6102'],
    ['VENDA_PROD', 'Venda de produção própria', 'S', 'sale', 1, true, 'own', true, true, '5101', '6101'],
    ['VENDA_ST', 'Venda de mercadoria com ST (substituído)', 'S', 'sale', 1, true, 'own', true, true, '5405', '6404'],
    ['DEV_VENDA', 'Devolução de venda', 'E', 'sale_return', 4, true, 'own', true, true, '1202', '2202'],
    ['COMPRA', 'Compra para comercialização', 'E', 'purchase', 1, true, 'own', true, true, '1102', '2102'],
    ['COMPRA_ST', 'Compra para comercialização com ST', 'E', 'purchase', 1, true, 'own', true, true, '1403', '2403'],
    ['COMPRA_CONSUMO', 'Compra para uso e consumo', 'E', 'purchase', 1, false, 'none', true, true, '1556', '2556'],
    ['DEV_COMPRA', 'Devolução de compra', 'S', 'purchase_return', 4, true, 'own', true, true, '5202', '6202'],
    ['TRANSF', 'Transferência entre filiais', 'S', 'transfer', 1, true, 'own', false, true, '5152', '6152'],
    ['BONIF', 'Remessa em bonificação', 'S', 'bonus', 1, true, 'own', false, true, '5910', '6910'],
    ['CONSERTO', 'Remessa para conserto', 'S', 'repair', 1, true, 'ours_with_third_party', false, true, '5915', '6915'],
    ['DEMO', 'Remessa para demonstração', 'S', 'demonstration', 1, true, 'ours_with_third_party', false, true, '5912', '6912'],
    ['CONSIG', 'Remessa em consignação', 'S', 'consignment', 1, true, 'ours_with_third_party', false, true, '5917', '6917'],
    ['ENTREGA_FUT', 'Venda para entrega futura (simples faturamento)', 'S', 'future_delivery', 1, false, 'none', true, true, '5922', '6922'],
    ['REM_ENTREGA_FUT', 'Remessa de venda para entrega futura', 'S', 'future_delivery_shipment', 1, true, 'own', false, true, '5117', '6117'],
    ['VENDA_ORDEM', 'Venda à ordem (faturamento ao adquirente originário)', 'S', 'third_party_order', 1, false, 'none', true, true, '5120', '6120'],
    ['REM_ORDEM', 'Remessa por conta e ordem de terceiros', 'S', 'third_party_shipment', 1, true, 'own', false, true, '5923', '6923'],
    ['PERDA', 'Baixa por perda, roubo ou deterioração', 'S', 'loss', 1, true, 'own', false, false, '5927', '5927'],
    ['SERVICO', 'Prestação de serviço', 'S', 'service', 1, false, 'none', true, true, '5933', '6933'],
  ];
  await createDefaultPostingRules(tx);
  for (const [code, name, dir, purpose, fin, stock, target, finan, fisc, cfi, cfx] of ops) {
    await tx.exec(
      `INSERT INTO fiscal.operation_types (tenant_id, code, name, direction, purpose, nfe_purpose, moves_stock, stock_target, generates_financial, generates_fiscal,
         generates_commission, fiscal_model, cfop_internal, cfop_interstate, category_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [t, code, name, dir, purpose, fin, stock, target, finan, fisc, purpose === 'sale' || purpose === 'future_delivery' || purpose === 'third_party_order',
        purpose === 'service' ? '99' : '55', cfi, cfx,
        purpose === 'sale' || purpose === 'future_delivery' || purpose === 'third_party_order' ? catIds.get('1') : purpose === 'service' ? catIds.get('1.1')
          : purpose === 'purchase' ? catIds.get('8') : purpose === 'sale_return' ? catIds.get('2.1') : null]);
  }
}

/** Padrões por empresa: contas financeiras e formas de pagamento ligadas a elas. */
export async function createCompanyDefaults(tx: Tx, companyId: string): Promise<void> {
  const t = tx.tenantId;
  const ledger = async (code: string) => (await tx.maybeOne<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = $1`, [code]))?.id ?? null;
  const caixa = await tx.one<{ id: string }>(
    `INSERT INTO finance.accounts (tenant_id, company_id, code, name, kind, ledger_account_id) VALUES ($1,$2,'CAIXA','Caixa da loja','cash',$3) RETURNING id`,
    [t, companyId, await ledger('1.1.1.01')]);
  const banco = await tx.one<{ id: string }>(
    `INSERT INTO finance.accounts (tenant_id, company_id, code, name, kind, ledger_account_id) VALUES ($1,$2,'BANCO','Banco principal','bank',$3) RETURNING id`,
    [t, companyId, await ledger('1.1.1.02')]);
  const adq = await tx.one<{ id: string }>(
    `INSERT INTO finance.accounts (tenant_id, company_id, code, name, kind, ledger_account_id) VALUES ($1,$2,'ADQUIRENTE','Recebíveis de cartão','acquirer',$3) RETURNING id`,
    [t, companyId, await ledger('1.1.2.02')]);
  const methods: [string, string, string, string, string, string, number][] = [
    ['DINHEIRO', 'Dinheiro', 'cash', '01', caixa.id, '0', 0],
    ['PIX', 'Pix', 'pix', '17', banco.id, '0', 0],
    ['BOLETO', 'Boleto bancário', 'boleto', '15', banco.id, '0', 0],
    ['TRANSF', 'Transferência', 'transfer', '18', banco.id, '0', 0],
    ['CREDITO', 'Cartão de crédito', 'credit_card', '03', adq.id, '3.5', 30],
    ['DEBITO', 'Cartão de débito', 'debit_card', '04', adq.id, '1.5', 1],
    ['CRED_LOJA', 'Crédito em loja', 'store_credit', '05', caixa.id, '0', 0],
  ];
  for (const [code, name, kind, tpag, acc, fee, days] of methods) {
    await tx.exec(
      `INSERT INTO registry.payment_methods (tenant_id, code, name, kind, nfe_tpag, financial_account_id, fee_percent, settlement_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, code) DO NOTHING`,
      [t, code, name, kind, tpag, acc, fee, days]);
  }
}
