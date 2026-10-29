import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { statusLabel } from '../lib/format';

// ------------------------------------------------------------------ campos de formulário

export function Field({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: ReactNode }) {
  // Dica e erro ficam fora do <label>: o nome acessível do campo é só o rótulo
  return (
    <div className="field">
      <label className="field">
        <span>{label}</span>
        {children}
      </label>
      {error ? <small className="err" role="alert">{error}</small> : hint ? <small className="muted">{hint}</small> : null}
    </div>
  );
}

export function Input(props: ComponentPropsWithRef<'input'> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <input {...rest} className={`input${className ? ` ${className}` : ''}`} aria-invalid={invalid || undefined} />;
}

export function Select(props: ComponentPropsWithRef<'select'> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <select {...rest} className={`input${className ? ` ${className}` : ''}`} aria-invalid={invalid || undefined} />;
}

// ------------------------------------------------------------------ cabeçalho, situação e avisos

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <span className="spacer" />
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

const TONE: Record<string, string> = {
  autorizada: 'ok', paid: 'ok', invoiced: 'ok', approved: 'ok', completed: 'ok', confirmed: 'ok', active: 'ok', resolved: 'ok',
  rejeitada: 'bad', denegada: 'bad', cancelled: 'bad', cancelada: 'bad', blocked: 'bad', critical: 'bad',
  pending_approval: 'warn', pendente_envio: 'warn', contingencia: 'warn', partially_paid: 'warn', partially_invoiced: 'warn', pending: 'warn', warning: 'warn', open: 'info',
};
export function Status({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return null;
  return <span className={`badge ${TONE[value] ?? ''}`}>{label ?? statusLabel(value)}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  const fields = error instanceof ApiError ? Object.entries(error.fieldErrors) : [];
  const rule = error instanceof ApiError ? (error.body.details as { rule?: string } | undefined)?.rule : undefined;
  return (
    <div className="alert bad" role="alert">
      <strong>{msg}</strong>{rule ? <span className="muted"> ({rule})</span> : null}
      {fields.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{fields.map(([k, v]) => <li key={k}><span className="mono">{k}</span>: {v}</li>)}</ul>}
    </div>
  );
}

// ------------------------------------------------------------------ diálogo

export function Dialog({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.close)');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <span className="spacer" />
          <button type="button" className="btn ghost sm close" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ avisos (toasts)

interface Toast { id: number; text: string; tone: 'ok' | 'bad' | 'info' }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ atalhos de teclado

/** Atalhos da tela (ex.: { F9: salvar, 'Ctrl+Enter': faturar }). Funcionam mesmo com foco em campos. */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && e.key.length > 1 ? 'Shift+' : ''}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
      const h = map[combo];
      if (h) {
        e.preventDefault();
        h(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Kpi({ label, value, delta, tone }: { label: string; value: ReactNode; delta?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && <div className={`delta ${tone ?? 'muted'}`}>{delta}</div>}
    </div>
  );
}
