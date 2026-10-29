import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ThemeToggle, VortexSymbol, VortexWordmark } from '@vortex/brand';
import { useAuth } from '../auth/AuthContext';
import { CommandPalette } from '../components/CommandPalette';
import { useHotkeys } from '../components/ui';

export interface NavItem { label: string; to: string; perm: string | string[]; group: string; icon: keyof typeof ICONS; end?: boolean }

/** Ícones de traço (24×24), no mesmo peso dos do PDV. */
const ICONS = {
  dashboard: 'M3 13h8V3H3zM13 21h8v-8h-8zM3 21h8v-6H3zM13 3v8h8V3z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  report: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  check: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  plus: 'M12 5v14M5 12h14',
  store: 'M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  swap: 'M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4',
  truck: 'M1 4h14v12H1zM15 9h4l3 3v4h-7M5.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM18.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  cart: 'M3 3h2l2.4 12.2a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L22 7H6M9 21h.01M18 21h.01',
  wallet: 'M3 7h18v13H3zM3 7l3-4h12l3 4M16 14h.01',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  bank: 'M3 21h18M5 21V10M19 21V10M9 21v-7M15 21v-7M12 3 2 8h20z',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  percent: 'M19 5 5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18',
} as const;

export function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export const NAV: NavItem[] = [
  { group: 'Gestão', label: 'Painel do dono', to: '/painel', perm: 'relatorios.painel.ler', icon: 'dashboard' },
  { group: 'Gestão', label: 'Assistente IA', to: '/ia', perm: 'ia.assistente.usar', icon: 'chat' },
  { group: 'Gestão', label: 'Relatórios', to: '/relatorios', perm: 'relatorios.relatorio.ler', icon: 'report' },
  { group: 'Gestão', label: 'Aprovações', to: '/aprovacoes', perm: [], icon: 'check' },
  { group: 'Vendas', label: 'Pedidos', to: '/vendas/pedidos', perm: 'vendas.pedido.ler', icon: 'list', end: true },
  { group: 'Vendas', label: 'Novo pedido', to: '/vendas/pedidos/novo', perm: 'vendas.pedido.criar', icon: 'plus' },
  { group: 'Vendas', label: 'Loja física (PDV)', to: '/vendas/pdv', perm: 'pdv.operador.consultar', icon: 'store' },
  { group: 'Estoque', label: 'Saldos', to: '/estoque', perm: 'estoque.saldo.ler', icon: 'box', end: true },
  { group: 'Estoque', label: 'Movimentações', to: '/estoque/movimentacoes', perm: 'estoque.saldo.ler', icon: 'swap' },
  { group: 'Estoque', label: 'Fornecedores', to: '/estoque/fornecedores', perm: 'compras.pedido.ler', icon: 'truck' },
  { group: 'Estoque', label: 'Compras', to: '/compras/recebimentos', perm: ['compras.recebimento.criar', 'compras.pedido.ler'], icon: 'cart' },
  { group: 'Cadastros', label: 'Pessoas', to: '/pessoas', perm: 'cadastros.pessoa.ler', icon: 'users' },
  { group: 'Cadastros', label: 'Produtos', to: '/produtos', perm: 'produtos.produto.ler', icon: 'tag' },
  { group: 'Financeiro', label: 'Títulos', to: '/financeiro/titulos', perm: 'financeiro.titulo.ler', icon: 'wallet' },
  { group: 'Financeiro', label: 'Fluxo de caixa', to: '/financeiro/fluxo', perm: 'financeiro.relatorio.ler', icon: 'trend' },
  { group: 'Financeiro', label: 'Conciliação', to: '/financeiro/conciliacao', perm: 'financeiro.conciliacao.executar', icon: 'bank' },
  { group: 'Fiscal', label: 'Notas emitidas', to: '/fiscal/notas', perm: 'fiscal.nota.ler', icon: 'file' },
  { group: 'Fiscal', label: 'Impostos (ICMS e outros)', to: '/fiscal/impostos', perm: 'fiscal.nota.ler', icon: 'percent' },
  { group: 'Fiscal', label: 'Obrigações', to: '/obrigacoes', perm: 'contabil.exportacao.gerar', icon: 'calendar' },
];

/** Item sem permissão listada (aprovações) aparece para todos: a API filtra o que cada um decide. */
export const allowed = (can: (p: string) => boolean) => (n: NavItem) => (Array.isArray(n.perm) ? n.perm.length === 0 || n.perm.some(can) : can(n.perm));

export function AppShell() {
  const { me, can, companyId, setCompany, signOut } = useAuth();
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  useHotkeys({
    'Ctrl+K': () => setPalette(true),
    '/': (e) => {
      const t = e.target as HTMLElement;
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) setPalette(true);
    },
  });
  const items = NAV.filter(allowed(can));
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="shell">
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <aside className={`sidebar${menu ? ' open' : ''}`} aria-label="Menu principal">
        <Link to="/" className="brand" aria-label="VORTEX ERP — início">
          <VortexSymbol size={26} glow />
          <span className="brand-name"><VortexWordmark size={11} title="VORTEX" /><span className="brand-product">ERP</span></span>
        </Link>
        <nav className="nav">
          {groups.map((g) => (
            <div key={g}>
              <div className="nav-group">{g}</div>
              {items.filter((i) => i.group === g).map((i) => <NavLink key={i.to} to={i.to} end={i.end}><NavIcon name={i.icon} />{i.label}</NavLink>)}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">AI OPERATING COMPANY</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="btn ghost menu-btn" aria-label="Abrir menu" onClick={() => setMenu(true)}>☰</button>
          <button type="button" className="search-trigger" onClick={() => setPalette(true)} aria-label="Busca global">
            <span>Buscar…</span><kbd>Ctrl K</kbd>
          </button>
          <span className="spacer" />
          {me && me.companies.length > 0 && (
            <select className="input hide-sm" style={{ width: 'auto', maxWidth: 260 }} aria-label="Empresa" value={companyId ?? ''} onChange={(e) => setCompany(e.target.value)}>
              {me.companies.map((c) => <option key={c.id} value={c.id}>{c.trade_name ?? c.legal_name}</option>)}
            </select>
          )}
          <ThemeToggle className="theme-btn" />
          <span className="hide-sm muted" title={me?.user?.email}>{me?.user?.name}</span>
          <button type="button" className="btn ghost sm" onClick={signOut}>Sair</button>
        </header>
        <main className="content"><Outlet /></main>
      </div>
      {palette && <CommandPalette pages={items.map((i) => ({ label: i.label, to: i.to }))} onClose={() => setPalette(false)} />}
    </div>
  );
}
