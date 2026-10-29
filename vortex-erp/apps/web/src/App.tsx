import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell, NAV, allowed } from './layout/AppShell';
import { LoginPage, MfaSetupPage } from './pages/LoginPage';

// Cada módulo em um pedaço próprio: a primeira tela carrega rápido (meta: < 500 ms p95)
const Dashboard = lazy(() => import('./pages/DashboardPage'));
const Parties = lazy(() => import('./pages/parties/PartiesPage'));
const Products = lazy(() => import('./pages/products/ProductsPage'));
const Orders = lazy(() => import('./pages/sales/OrdersPage'));
const OrderEntry = lazy(() => import('./pages/sales/OrderEntryPage'));
const OrderDetail = lazy(() => import('./pages/sales/OrderDetailPage'));
const Receipts = lazy(() => import('./pages/purchasing/ReceiptsPage'));
const ReceiptDetail = lazy(() => import('./pages/purchasing/ReceiptDetailPage'));
const Stock = lazy(() => import('./pages/stock/StockPage'));
const Titles = lazy(() => import('./pages/finance/TitlesPage'));
const Reconciliation = lazy(() => import('./pages/finance/ReconciliationPage'));
const CashFlow = lazy(() => import('./pages/finance/CashFlowPage'));
const FiscalDocs = lazy(() => import('./pages/fiscal/FiscalDocumentsPage'));
const Reports = lazy(() => import('./pages/reports/ReportsPage'));
const Assistant = lazy(() => import('./pages/ai/AssistantPage'));
const Obligations = lazy(() => import('./pages/obligations/ObligationsPage'));
const Approvals = lazy(() => import('./pages/ApprovalsPage'));
const Pdv = lazy(() => import('./pages/pdv/PdvPage'));
const Movements = lazy(() => import('./pages/stock/MovementsPage'));
const Suppliers = lazy(() => import('./pages/stock/SuppliersPage'));
const Taxes = lazy(() => import('./pages/fiscal/TaxesPage'));

function Protected({ children }: { children: ReactNode }) {
  const { token, loading } = useAuth();
  if (!token) return <Navigate to="/entrar" replace />;
  if (loading) return <div className="empty">Carregando…</div>;
  return <>{children}</>;
}

/** Primeira tela permitida para o perfil (vendedor cai em pedidos, financeiro em títulos…). */
function Home() {
  const { can } = useAuth();
  const first = NAV.filter((n) => !Array.isArray(n.perm) || n.perm.length > 0).find(allowed(can));
  return first ? <Navigate to={first.to} replace /> : <div className="empty">Seu usuário ainda não tem permissões. Fale com o administrador.</div>;
}

export function App() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/mfa" element={<MfaSetupPage />} />
      <Route element={<Protected><AppShell /></Protected>}>
        <Route index element={<Home />} />
        <Route path="painel" element={<Lazy><Dashboard /></Lazy>} />
        <Route path="pessoas" element={<Lazy><Parties /></Lazy>} />
        <Route path="produtos" element={<Lazy><Products /></Lazy>} />
        <Route path="vendas/pedidos" element={<Lazy><Orders /></Lazy>} />
        <Route path="vendas/pedidos/novo" element={<Lazy><OrderEntry /></Lazy>} />
        <Route path="vendas/pedidos/:id" element={<Lazy><OrderDetail /></Lazy>} />
        <Route path="compras/recebimentos" element={<Lazy><Receipts /></Lazy>} />
        <Route path="compras/recebimentos/:id" element={<Lazy><ReceiptDetail /></Lazy>} />
        <Route path="vendas/pdv" element={<Lazy><Pdv /></Lazy>} />
        <Route path="estoque" element={<Lazy><Stock /></Lazy>} />
        <Route path="estoque/movimentacoes" element={<Lazy><Movements /></Lazy>} />
        <Route path="estoque/fornecedores" element={<Lazy><Suppliers /></Lazy>} />
        <Route path="fiscal/impostos" element={<Lazy><Taxes /></Lazy>} />
        <Route path="financeiro/titulos" element={<Lazy><Titles /></Lazy>} />
        <Route path="financeiro/conciliacao" element={<Lazy><Reconciliation /></Lazy>} />
        <Route path="financeiro/fluxo" element={<Lazy><CashFlow /></Lazy>} />
        <Route path="fiscal/notas" element={<Lazy><FiscalDocs /></Lazy>} />
        <Route path="relatorios" element={<Lazy><Reports /></Lazy>} />
        <Route path="ia" element={<Lazy><Assistant /></Lazy>} />
        <Route path="obrigacoes" element={<Lazy><Obligations /></Lazy>} />
        <Route path="aprovacoes" element={<Lazy><Approvals /></Lazy>} />
        <Route path="*" element={<div className="empty">Página não encontrada.</div>} />
      </Route>
    </Routes>
  );
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="empty">Carregando…</div>}>{children}</Suspense>;
}
