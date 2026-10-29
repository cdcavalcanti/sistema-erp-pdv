/**
 * Perfis da seção 5 traduzidos em permissões vindas do ERP. O PDV decide offline com a
 * lista de permissões de cada operador sincronizada do ERP.
 */
export const P = {
  sell: 'pdv.venda.operar',
  openCash: 'pdv.caixa.abrir',
  customer: 'pdv.cliente.cadastrar',
  ownSales: 'pdv.venda.consultar',
  authorizeDiscount: 'pdv.desconto.autorizar',
  authorizeItemCancel: 'pdv.item.autorizar_cancelamento',
  cancelSale: 'pdv.venda.cancelar',
  authorizeReturn: 'pdv.devolucao.autorizar',
  withdrawal: 'pdv.caixa.sangria',
  supply: 'pdv.caixa.suprimento',
  reprint: 'pdv.documento.reimprimir',
  closeCash: 'pdv.caixa.fechar',
  reopenCash: 'pdv.caixa.reabrir',
  operators: 'pdv.operador.consultar',
  reports: 'pdv.relatorio.ver',
  settings: 'pdv.parametro.configurar',
} as const;

export type Permission = (typeof P)[keyof typeof P];

export interface Operator {
  id: string;
  name: string;
  login: string;
  permissions: string[];
  roles: string[];
  discountLimitPercent: string;
}

export const can = (op: Pick<Operator, 'permissions'>, perm: string) => op.permissions.includes(perm);
