import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, session } from '../api/client';

export interface Me {
  user: { id: string; name: string; email: string; mfa_enabled: boolean } | null;
  tenant: { id: string; name: string; slug: string };
  companies: { id: string; legal_name: string; trade_name: string | null; cnpj_root: string }[];
  companyId: string | null;
  roles: string[];
  permissions: string[];
  establishmentIds: string[] | null;
}

interface AuthState {
  token: string | null;
  me: Me | undefined;
  loading: boolean;
  companyId: string | null;
  can: (perm: string) => boolean;
  setCompany: (id: string) => void;
  signIn: (token: string) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(session.token);
  const [companyId, setCompanyId] = useState(session.companyId);
  useEffect(() => session.onChange(() => {
    setToken(session.token);
    setCompanyId(session.companyId);
  }), []);
  const me = useQuery({ queryKey: ['me', token, companyId], queryFn: () => api.get<Me>('/v1/me'), enabled: !!token, staleTime: 60_000 });
  // Sem empresa escolhida: usa a primeira (a maioria dos clientes tem uma só)
  useEffect(() => {
    if (me.data && !companyId && me.data.companies[0]) session.setCompany(me.data.companies[0].id);
  }, [me.data, companyId]);
  const perms = useMemo(() => new Set(me.data?.permissions ?? []), [me.data]);
  const can = useCallback((p: string) => perms.has('*') || perms.has(p), [perms]);
  const value: AuthState = {
    token, me: me.data, loading: !!token && me.isLoading, companyId, can,
    setCompany: (id) => {
      session.setCompany(id);
      qc.invalidateQueries();
    },
    signIn: (t) => session.setToken(t),
    signOut: () => {
      session.setToken(null);
      session.setCompany(null);
      qc.clear();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth fora do AuthProvider');
  return c;
}
