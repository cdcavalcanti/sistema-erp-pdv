import type { Status, Terminal } from '../App';
import { VortexLockup } from '@vortex/brand';
import { StatusBar } from './StatusBar';

/** Terminal ainda sem carga do ERP: instrução de pareamento. */
export function NotPairedScreen({ terminal, status, onRetry }: { terminal: Terminal; status: Status | null; onRetry: () => void }) {
  return (
    <div className="screen center">
      <StatusBar terminal={terminal} status={status} />
      <div className="login-stage">
        <VortexLockup size={56} glow tagline="PONTO DE VENDA" />
        <div className="card login">
          <h1>Terminal {terminal.terminal} não pareado</h1>
          <p>Cadastre o terminal no ERP (Terminais de PDV) e rode no computador do caixa:</p>
          <pre className="code">pnpm --filter @vortex/pdv pair --key &lt;chave do terminal&gt; --store &lt;id da loja&gt;</pre>
          <p className="muted">Depois do pareamento, produtos, preços, operadores e parâmetros são carregados do ERP.</p>
          <button className="primary" onClick={onRetry}>Verificar novamente</button>
        </div>
      </div>
    </div>
  );
}
