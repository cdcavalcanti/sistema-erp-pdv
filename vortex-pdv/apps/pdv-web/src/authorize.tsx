import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './lib/api';
import { Alert, Field, Modal } from './ui';

export interface Authorization {
  login: string;
  pin: string;
}

type Runner = <T>(fn: (auth?: Authorization) => Promise<T>) => Promise<T>;
const Ctx = createContext<Runner | null>(null);

const PERMISSION_LABEL: Record<string, string> = {
  'pdv.desconto.autorizar': 'desconto acima do seu limite',
  'pdv.item.autorizar_cancelamento': 'cancelamento de item',
  'pdv.venda.cancelar': 'cancelamento da venda',
  'pdv.devolucao.autorizar': 'devolução',
  'pdv.caixa.sangria': 'sangria',
  'pdv.caixa.suprimento': 'suprimento',
  'pdv.documento.reimprimir': 'reimpressão',
  'pdv.caixa.fechar': 'fechamento do caixa',
  'pdv.caixa.reabrir': 'reabertura do caixa',
  'pdv.caixa.abrir': 'abertura do caixa',
};

/**
 * Autorização de supervisor (seção 5): quando o agente responde AUTHORIZATION_REQUIRED, pede
 * login e PIN de quem pode autorizar e repete a mesma ação com a autorização.
 */
export function AuthorizationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ message: string; permission: string; resolve: (a: Authorization | null) => void } | null>(null);
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  // Nova tentativa (PIN errado) mantém o usuário e limpa só o PIN
  const ask = (message: string, permission: string) => new Promise<Authorization | null>((resolve) => {
    setPin('');
    setPending({ message, permission, resolve });
  });

  const run = useCallback<Runner>(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || !e.needsAuthorization) throw e;
      let message = e.message;
      setLogin('');
      setError(null);
      for (;;) {
        const auth = await ask(message, String(e.details.permission ?? ''));
        if (!auth) throw new ApiError(403, 'AUTHORIZATION_CANCELLED', 'Autorização cancelada');
        try {
          const out = await fn(auth);
          setPending(null);
          return out;
        } catch (err) {
          if (err instanceof ApiError && ['INVALID_CREDENTIALS', 'FORBIDDEN', 'LOCKED'].includes(err.code)) {
            message = err.message;
            setError(err.message);
            continue;
          }
          setPending(null);
          throw err;
        }
      }
    }
  }, []);

  return (
    <Ctx.Provider value={run}>
      {children}
      {pending && (
        <Modal title="Autorização do supervisor" onClose={() => { pending.resolve(null); setPending(null); setError(null); }}
          onSubmit={() => { setError(null); pending.resolve({ login: login.trim(), pin }); }}
          footer={<button className="primary" type="submit">Autorizar <kbd>ENTER</kbd></button>}>
          <Alert kind="warn">{pending.message}{PERMISSION_LABEL[pending.permission] ? ` (${PERMISSION_LABEL[pending.permission]})` : ''}</Alert>
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="Usuário do supervisor">
            <input data-autofocus value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && login && (e.preventDefault(), pinRef.current?.focus())} />
          </Field>
          <Field label="PIN">
            <input ref={pinRef} type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
          </Field>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export function useAuthorized(): Runner {
  const r = useContext(Ctx);
  if (!r) throw new Error('AuthorizationProvider ausente');
  return r;
}
