import { useEffect, useRef, type ReactNode } from 'react';

/** Janela sobre a venda: foco no primeiro campo, ESC volta, ENTER confirma (seção 41). */
export function Modal({ title, onClose, children, wide, footer, onSubmit, tone }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; onSubmit?: () => void; tone?: 'danger' | 'ok';
}) {
  const ref = useRef<HTMLFormElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Foco só ao abrir: refocar a cada renderização roubaria o campo em que o operador digita
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button.primary')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form ref={ref} className={`modal ${wide ? 'wide' : ''} ${tone ?? ''}`} role="dialog" aria-modal="true" aria-label={title}
        onSubmit={(e) => { e.preventDefault(); onSubmit?.(); }}>
        <header><h2>{title}</h2><button type="button" className="icon" aria-label="Fechar" onClick={onClose}>ESC</button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </form>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'warn' | 'ok' | 'info'; children: ReactNode }) {
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Key({ k }: { k: string }) {
  return <kbd>{k}</kbd>;
}
