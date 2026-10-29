import pg from 'pg';

/**
 * Catálogo de permissões no formato modulo.recurso.acao (seção 04).
 * É a fonte da verdade: sincronizado com core.permissions a cada migrate.
 */
export const PERMISSIONS: Record<string, string> = {
  // Administração
  'admin.empresa.gerenciar': 'Gerenciar empresas, estabelecimentos, depósitos e séries',
  'admin.usuario.gerenciar': 'Gerenciar usuários, papéis e escopos',
  'admin.auditoria.ler': 'Consultar log de auditoria',
  'admin.integracao.gerenciar': 'Gerenciar chaves de API e webhooks',
  'admin.aprovacao.decidir': 'Decidir solicitações de aprovação genéricas',
  // Cadastros
  'cadastros.pessoa.ler': 'Consultar pessoas',
  'cadastros.pessoa.criar': 'Cadastrar pessoas',
  'cadastros.pessoa.editar': 'Alterar pessoas',
  'cadastros.pessoa.inativar': 'Inativar/bloquear pessoas',
  'cadastros.conta_bancaria.criar': 'Cadastrar/alterar conta bancária e chave Pix de pessoa',
  'cadastros.conta_bancaria.aprovar': 'Aprovar alteração de conta bancária (dupla aprovação)',
  'cadastros.tabela.ler': 'Consultar tabelas auxiliares',
  'cadastros.tabela.editar': 'Alterar tabelas auxiliares (condições, formas, contas, plano, tipos de operação)',
  // Produtos e preços
  'produtos.produto.ler': 'Consultar produtos',
  'produtos.produto.criar': 'Cadastrar produtos',
  'produtos.produto.editar': 'Alterar produtos',
  'produtos.preco.ler': 'Consultar tabelas de preço',
  'produtos.preco.editar': 'Alterar preços e promoções',
  'produtos.preco.aprovar': 'Aprovar venda abaixo do custo/margem mínima',
  'produtos.custo.editar': 'Alterar preço de custo manualmente (ação sensível)',
  // Fiscal
  'fiscal.regra.ler': 'Consultar regras fiscais',
  'fiscal.regra.editar': 'Alterar regras fiscais',
  'fiscal.nota.ler': 'Consultar documentos fiscais',
  'fiscal.nota.emitir': 'Emitir documentos fiscais',
  'fiscal.nota.cancelar': 'Cancelar documentos fiscais',
  'fiscal.nota.corrigir': 'Emitir carta de correção',
  'fiscal.nota.inutilizar': 'Inutilizar numeração',
  'fiscal.entrada.ler': 'Consultar notas de entrada (DF-e)',
  'fiscal.entrada.manifestar': 'Manifestar notas de entrada',
  'fiscal.certificado.gerenciar': 'Enviar e substituir certificado digital',
  // Estoque
  'estoque.saldo.ler': 'Consultar saldos e kardex',
  'estoque.movimento.criar': 'Lançar movimentos manuais (perda, avaria, consumo, transferência)',
  'estoque.movimento.aprovar': 'Aprovar baixas acima do limite',
  'estoque.inventario.criar': 'Abrir e contar inventário',
  'estoque.inventario.aprovar': 'Aprovar diferenças de inventário',
  // Vendas
  'vendas.orcamento.ler': 'Consultar orçamentos',
  'vendas.orcamento.criar': 'Criar orçamentos',
  'vendas.pedido.ler': 'Consultar pedidos',
  'vendas.pedido.criar': 'Criar pedidos',
  'vendas.pedido.editar': 'Alterar pedidos não faturados',
  'vendas.pedido.aprovar': 'Aprovar pedidos bloqueados',
  'vendas.pedido.cancelar': 'Cancelar pedidos',
  'vendas.pedido.faturar': 'Faturar pedidos',
  'vendas.devolucao.criar': 'Registrar devoluções e trocas',
  'vendas.comissao.ler': 'Consultar comissões',
  'vendas.meta.editar': 'Definir metas',
  // Compras
  'compras.requisicao.criar': 'Criar requisições de compra',
  'compras.cotacao.criar': 'Criar cotações',
  'compras.servico_tomado.lancar': 'Lançar NFS-e de serviços tomados (com retenções na fonte)',
  'compras.pedido.ler': 'Consultar pedidos de compra',
  'compras.pedido.criar': 'Criar pedidos de compra',
  'compras.pedido.aprovar': 'Aprovar pedidos de compra',
  'compras.recebimento.criar': 'Receber mercadorias',
  'compras.recebimento.aprovar': 'Liberar divergências de recebimento',
  'compras.recebimento.sem_pedido': 'Aceitar nota sem pedido de compra',
  'compras.devolucao.criar': 'Devolver a fornecedor',
  // Financeiro
  'financeiro.titulo.ler': 'Consultar títulos',
  'financeiro.titulo.criar': 'Lançar títulos manuais',
  'financeiro.titulo.baixar': 'Baixar títulos',
  'financeiro.titulo.estornar': 'Estornar baixas',
  'financeiro.titulo.renegociar': 'Renegociar títulos',
  'financeiro.titulo.aprovar': 'Aprovar pagamentos',
  'financeiro.conta.ler': 'Consultar contas e extratos',
  'financeiro.conta.editar': 'Gerenciar contas financeiras',
  'financeiro.bordero.criar': 'Montar borderô de pagamento',
  'financeiro.conciliacao.executar': 'Conciliar extratos',
  'financeiro.relatorio.ler': 'Fluxo de caixa, DRE, orçamento',
  'financeiro.orcamento.editar': 'Editar orçamento anual',
  // Contábil
  'contabil.lancamento.ler': 'Consultar lançamentos contábeis',
  'contabil.lancamento.criar': 'Lançamentos manuais',
  'contabil.periodo.fechar': 'Fechar período',
  'contabil.periodo.reabrir': 'Reabrir período (perfil contador)',
  'contabil.exportacao.gerar': 'Gerar exportação ao contador e arquivos SPED',
  // Contratos, produção, IA, relatórios, PDV
  'contratos.contrato.ler': 'Consultar contratos',
  'contratos.contrato.editar': 'Gerenciar contratos e ordens de serviço',
  'producao.ficha.editar': 'Gerenciar fichas técnicas',
  'producao.ordem.editar': 'Gerenciar ordens de produção',
  'relatorios.painel.ler': 'Painel do dono',
  'relatorios.relatorio.ler': 'Relatórios operacionais',
  'ia.assistente.usar': 'Usar o assistente de IA',
  'pdv.sincronizacao.executar': 'Sincronizar PDV (catálogo e vendas)',
  // PDV (frente de caixa): perfis da especificação do PDV, seção 5
  'pdv.venda.operar': 'PDV: vender, consultar produtos e receber pagamentos',
  'pdv.caixa.abrir': 'PDV: abrir caixa',
  'pdv.cliente.cadastrar': 'PDV: identificar e cadastrar cliente na venda',
  'pdv.venda.consultar': 'PDV: consultar as próprias vendas',
  'pdv.desconto.autorizar': 'PDV: autorizar desconto acima do limite do operador',
  'pdv.item.autorizar_cancelamento': 'PDV: autorizar cancelamento de item',
  'pdv.venda.cancelar': 'PDV: cancelar venda',
  'pdv.devolucao.autorizar': 'PDV: autorizar devolução',
  'pdv.caixa.sangria': 'PDV: fazer sangria',
  'pdv.caixa.suprimento': 'PDV: fazer suprimento',
  'pdv.documento.reimprimir': 'PDV: reimprimir comprovante e documento fiscal',
  'pdv.caixa.fechar': 'PDV: fechar caixa',
  'pdv.caixa.reabrir': 'PDV: reabrir caixa',
  'pdv.operador.consultar': 'PDV: consultar operadores e caixas',
  'pdv.relatorio.ver': 'PDV: painel e relatórios operacionais',
  'pdv.parametro.configurar': 'PDV: configurar parâmetros locais permitidos pelo ERP',
  'pdv.terminal.gerenciar': 'Cadastrar terminais de PDV, parâmetros da loja e PIN de operadores',
  'rh.colaborador.ler': 'Consultar colaboradores',
  'rh.colaborador.editar': 'Gerenciar colaboradores, cargos e departamentos',
  'rh.folha.importar': 'Importar o resumo da folha de pagamento',
  'rh.reembolso.solicitar': 'Solicitar reembolso de despesas',
  'rh.reembolso.aprovar': 'Aprovar reembolso de despesas',
};

const all = Object.keys(PERMISSIONS);
const byPrefix = (...prefixes: string[]) => all.filter((p) => prefixes.some((x) => p.startsWith(x)));

const PDV_OPERATOR = ['pdv.venda.operar', 'pdv.caixa.abrir', 'pdv.cliente.cadastrar', 'pdv.venda.consultar'];
const PDV_SUPERVISOR = [...PDV_OPERATOR, 'pdv.desconto.autorizar', 'pdv.item.autorizar_cancelamento', 'pdv.venda.cancelar', 'pdv.devolucao.autorizar',
  'pdv.caixa.sangria', 'pdv.caixa.suprimento', 'pdv.documento.reimprimir'];

/** Papéis padrão criados para cada tenant novo (seção 04). */
export const DEFAULT_ROLES: { code: string; name: string; requiresMfa: boolean; permissions: string[] }[] = [
  {
    code: 'vendedor', name: 'Vendedor', requiresMfa: false,
    permissions: ['cadastros.pessoa.ler', 'cadastros.pessoa.criar', 'produtos.produto.ler', 'produtos.preco.ler', 'estoque.saldo.ler',
      'vendas.orcamento.ler', 'vendas.orcamento.criar', 'vendas.pedido.ler', 'vendas.pedido.criar', 'vendas.pedido.editar', 'vendas.comissao.ler', 'cadastros.tabela.ler',
      'rh.reembolso.solicitar'],
  },
  {
    code: 'comprador', name: 'Comprador', requiresMfa: false,
    permissions: ['cadastros.pessoa.ler', 'cadastros.pessoa.criar', 'produtos.produto.ler', 'estoque.saldo.ler', 'cadastros.tabela.ler',
      ...byPrefix('compras.'), 'fiscal.entrada.ler', 'fiscal.entrada.manifestar', 'rh.reembolso.solicitar', 'ia.assistente.usar'].filter((p) => p !== 'compras.pedido.aprovar'),
  },
  {
    code: 'estoquista', name: 'Estoquista', requiresMfa: false,
    permissions: ['produtos.produto.ler', 'estoque.saldo.ler', 'estoque.movimento.criar', 'estoque.inventario.criar', 'compras.recebimento.criar', 'compras.pedido.ler', 'cadastros.tabela.ler',
      'rh.reembolso.solicitar'],
  },
  {
    code: 'financeiro', name: 'Financeiro', requiresMfa: true,
    permissions: ['cadastros.pessoa.ler', 'cadastros.conta_bancaria.criar', 'cadastros.tabela.ler', ...byPrefix('financeiro.'), 'relatorios.relatorio.ler', 'rh.colaborador.ler',
      'rh.folha.importar', 'rh.reembolso.solicitar', 'rh.reembolso.aprovar', 'ia.assistente.usar', 'compras.servico_tomado.lancar'],
  },
  {
    code: 'contador', name: 'Contador', requiresMfa: false,
    permissions: ['cadastros.pessoa.ler', 'produtos.produto.ler', 'fiscal.regra.ler', 'fiscal.regra.editar', 'fiscal.nota.ler', 'fiscal.entrada.ler',
      'financeiro.titulo.ler', 'financeiro.relatorio.ler', ...byPrefix('contabil.'), 'relatorios.relatorio.ler', 'cadastros.tabela.ler', 'estoque.saldo.ler', 'ia.assistente.usar'],
  },
  {
    code: 'gerente', name: 'Gerente', requiresMfa: false,
    permissions: byPrefix('cadastros.', 'produtos.', 'estoque.', 'vendas.', 'compras.', 'fiscal.nota.', 'fiscal.entrada.', 'fiscal.regra.ler', 'relatorios.', 'financeiro.titulo.ler', 'financeiro.relatorio.ler', 'contratos.', 'producao.', 'ia.', 'rh.colaborador.ler', 'rh.reembolso.', 'pdv.')
      .filter((p) => p !== 'cadastros.conta_bancaria.aprovar' && p !== 'produtos.custo.editar' && p !== 'pdv.sincronizacao.executar' && p !== 'pdv.terminal.gerenciar'),
  },
  { code: 'operador_caixa', name: 'Operador de caixa', requiresMfa: false, permissions: PDV_OPERATOR },
  { code: 'supervisor_caixa', name: 'Supervisor de caixa', requiresMfa: false, permissions: PDV_SUPERVISOR },
  { code: 'administrador', name: 'Administrador', requiresMfa: true, permissions: all },
];

/** Alçadas padrão de desconto (exemplo do guia: vendedor 5%, gerente 15%, acima disso diretoria). */
export const DEFAULT_LIMITS: { role: string; action: string; maxPercent?: string; maxValue?: string }[] = [
  { role: 'vendedor', action: 'vendas.desconto', maxPercent: '5' },
  // Desconto no PDV: acima do limite do operador exige autorização (especificação do PDV, seção 13)
  { role: 'operador_caixa', action: 'pdv.desconto', maxPercent: '5' },
  { role: 'supervisor_caixa', action: 'pdv.desconto', maxPercent: '15' },
  { role: 'gerente', action: 'pdv.desconto', maxPercent: '30' },
  { role: 'administrador', action: 'pdv.desconto', maxPercent: '100' },
  { role: 'gerente', action: 'vendas.desconto', maxPercent: '15' },
  { role: 'administrador', action: 'vendas.desconto', maxPercent: '100' },
  { role: 'estoquista', action: 'estoque.perda', maxValue: '500.00' },
  { role: 'gerente', action: 'estoque.perda', maxValue: '5000.00' },
  { role: 'administrador', action: 'estoque.perda', maxValue: '9999999999.99' },
  // Pedido de compra aprovado direto dentro da alçada; acima dela vai para aprovação
  { role: 'comprador', action: 'compras.pedido', maxValue: '5000.00' },
  { role: 'gerente', action: 'compras.pedido', maxValue: '50000.00' },
  { role: 'administrador', action: 'compras.pedido', maxValue: '9999999999.99' },
];

/**
 * Sincroniza o catálogo de permissões e leva as novidades aos tenants existentes:
 * papéis padrão que ainda não existem são criados (com suas alçadas) e permissões
 * que acabaram de entrar no catálogo são concedidas aos papéis de sistema que as
 * têm por padrão. Permissões antigas retiradas de um papel pelo cliente não voltam.
 */
export async function syncPermissionCatalog(ownerUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const codes = Object.keys(PERMISSIONS);
    const before = new Set((await client.query<{ code: string }>(`SELECT code FROM core.permissions`)).rows.map((r) => r.code));
    const fresh = before.size ? codes.filter((c) => !before.has(c)) : [];
    await client.query(
      `INSERT INTO core.permissions (code, description) SELECT * FROM unnest($1::text[], $2::text[])
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
      [codes, codes.map((c) => PERMISSIONS[c])],
    );
    const tenants = (await client.query<{ id: string }>(`SELECT id FROM core.tenants`)).rows;
    for (const t of tenants) {
      for (const role of DEFAULT_ROLES) {
        const existing = await client.query<{ id: string; is_system: boolean }>(`SELECT id, is_system FROM core.roles WHERE tenant_id = $1 AND code = $2`, [t.id, role.code]);
        let roleId = existing.rows[0]?.id;
        let grant = role.permissions.filter((p) => fresh.includes(p));
        if (!roleId) {
          roleId = (await client.query<{ id: string }>(
            `INSERT INTO core.roles (tenant_id, code, name, is_system, requires_mfa) VALUES ($1,$2,$3,true,$4) RETURNING id`, [t.id, role.code, role.name, role.requiresMfa])).rows[0]!.id;
          grant = role.permissions;
          for (const l of DEFAULT_LIMITS.filter((x) => x.role === role.code)) {
            await client.query(`INSERT INTO core.approval_limits (tenant_id, role_id, action, max_percent, max_value) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [t.id, roleId, l.action, l.maxPercent ?? null, l.maxValue ?? null]);
          }
        } else if (!existing.rows[0]!.is_system) {
          continue;
        } else {
          // Alçadas novas de papéis existentes (ex.: pdv.desconto)
          for (const l of DEFAULT_LIMITS.filter((x) => x.role === role.code && fresh.some((f) => f.startsWith(`${x.action}.`)))) {
            await client.query(`INSERT INTO core.approval_limits (tenant_id, role_id, action, max_percent, max_value) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [t.id, roleId, l.action, l.maxPercent ?? null, l.maxValue ?? null]);
          }
        }
        if (grant.length) {
          await client.query(`INSERT INTO core.role_permissions (tenant_id, role_id, permission) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`, [t.id, roleId, grant]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}
