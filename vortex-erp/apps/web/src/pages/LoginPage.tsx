import { useState, type ReactNode } from 'react';
import { ThemeToggle, VortexLockup, VortexSymbol } from '@vortex/brand';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@vortex/contracts';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Field, Input } from '../components/ui';

/** Moldura das telas de acesso: assinatura da marca no centro e a régua do rodapé da identidade visual. */
function BrandFrame({ children }: { children: ReactNode }) {
  return (
    <div className="login">
      <div className="login-top"><ThemeToggle className="theme-btn" /></div>
      <div className="login-body">
        <VortexLockup size={64} glow />
        {children}
      </div>
      <footer className="login-foot" aria-hidden="true">
        <VortexSymbol size={12} /><hr /><span>VORTEX ERP</span><hr className="hide-sm" /><span className="hide-sm">AI OPERATING COMPANY</span>
      </footer>
    </div>
  );
}

/** Login (VORTEX ID local) com MFA por aplicativo autenticador quando o perfil exige. */
export function LoginPage() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lastTenant = (() => {
    try {
      return localStorage.getItem('vx.tenant') ?? '';
    } catch {
      return '';
    }
  })();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { tenant: lastTenant, email: '', password: '' } });
  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await api.post<{ token: string; mfaSetupRequired: boolean }>('/v1/auth/login', { ...v, totp: v.totp || undefined });
      try {
        localStorage.setItem('vx.tenant', v.tenant);
      } catch {
        /* sem armazenamento local */
      }
      signIn(r.token);
      nav(r.mfaSetupRequired ? '/mfa' : '/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_CODE_REQUIRED') setNeedCode(true);
      else setError(e);
    }
  });
  return (
    <BrandFrame>
      <form className="card stack" onSubmit={submit} noValidate>
        <div>
          <h1>Entrar no VORTEX ERP</h1>
          <p className="muted" style={{ margin: 0 }}>Use o identificador da sua empresa, e-mail e senha.</p>
        </div>
        <Field label="Empresa (identificador)" error={errors.tenant?.message}>
          <Input autoComplete="organization" {...register('tenant')} invalid={!!errors.tenant} />
        </Field>
        <Field label="E-mail" error={errors.email?.message}>
          <Input type="email" autoComplete="username" {...register('email')} invalid={!!errors.email} />
        </Field>
        <Field label="Senha" error={errors.password?.message}>
          <Input type="password" autoComplete="current-password" {...register('password')} invalid={!!errors.password} />
        </Field>
        {needCode && (
          <Field label="Código do aplicativo autenticador" hint="6 dígitos (Google Authenticator, Authy…)">
            <Input inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} {...register('totp')} />
          </Field>
        )}
        <ErrorBox error={error} />
        <button className="btn primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </BrandFrame>
  );
}

/** Perfil com MFA obrigatório (financeiro, administrador): configura o autenticador no primeiro acesso. */
export function MfaSetupPage() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <BrandFrame>
      <div className="card stack">
        <h1>Ative a verificação em duas etapas</h1>
        <p className="muted" style={{ margin: 0 }}>Seu perfil movimenta dinheiro ou administra acessos e exige MFA.</p>
        {!setup ? (
          <button className="btn primary" type="button" onClick={async () => {
            try {
              setSetup(await api.post('/v1/auth/mfa/setup'));
            } catch (e) {
              setError(e);
            }
          }}>Gerar chave</button>
        ) : (
          <>
            <Field label="Chave para o aplicativo"><Input readOnly value={setup.secret} className="mono" /></Field>
            <a href={setup.otpauthUrl} className="muted">Abrir no aplicativo autenticador</a>
            <Field label="Código gerado"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <button className="btn primary" type="button" onClick={async () => {
              try {
                const r = await api.post<{ token: string }>('/v1/auth/mfa/activate', { code });
                signIn(r.token);
                nav('/', { replace: true });
              } catch (e) {
                setError(e);
              }
            }}>Ativar</button>
          </>
        )}
        <ErrorBox error={error} />
      </div>
    </BrandFrame>
  );
}
