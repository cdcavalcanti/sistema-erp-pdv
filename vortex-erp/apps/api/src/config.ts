function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  databaseOwnerUrl: string;
  workerDatabaseUrl: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  secretsMasterKey: Buffer;
  storageDir: string;
  fiscalGateway: 'simulated' | 'partner';
  fiscalPartnerUrl: string;
  fiscalPartnerToken: string;
  sefazAmbiente: 1 | 2;
  bankGateway: 'simulated' | 'partner';
  webhookSigningSecret: string;
  /** IA (seção 20): 'anthropic' usa a API do Claude; 'none' desliga e as funcionalidades usam as regras */
  aiProvider: 'anthropic' | 'none';
  aiModel: string;
  /** Chave do console VORTEX para provisionar tenants em produção (POST /v1/onboarding) */
  provisioningKey: string;
  /** Token Bearer do /metrics; sem ele o endpoint fica fechado em produção */
  metricsToken: string;
  /** Requisições por minuto por chave/token (o seed de demonstração aumenta) */
  rateLimitMax: number;
  logLevel: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV ?? 'development') as Config['env'];
  const isTest = env === 'test';
  const key = Buffer.from(req('SECRETS_MASTER_KEY', isTest ? 'ZGV2LWtleS1kZXYta2V5LWRldi1rZXktZGV2LWtleTE=' : undefined), 'base64');
  if (key.length !== 32) throw new Error('SECRETS_MASTER_KEY deve ter 32 bytes em base64');
  const cfg: Config = {
    env,
    port: Number(process.env.PORT ?? 3333),
    databaseUrl: req(isTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL', isTest ? 'postgres://vortex_app:vortex_app@localhost:5432/vortex_erp_test' : undefined),
    databaseOwnerUrl: req(isTest ? 'TEST_DATABASE_OWNER_URL' : 'DATABASE_OWNER_URL', isTest ? 'postgres://vortex_owner:vortex_owner@localhost:5432/vortex_erp_test' : undefined),
    workerDatabaseUrl: req(isTest ? 'TEST_WORKER_DATABASE_URL' : 'WORKER_DATABASE_URL', isTest ? 'postgres://vortex_worker:vortex_worker@localhost:5432/vortex_erp_test' : undefined),
    jwtSecret: req('JWT_SECRET', isTest ? 'test-secret-test-secret-test-secret-123' : undefined),
    jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 28800),
    secretsMasterKey: key,
    storageDir: process.env.STORAGE_DIR ?? './storage',
    fiscalGateway: (process.env.FISCAL_GATEWAY ?? 'simulated') as Config['fiscalGateway'],
    fiscalPartnerUrl: process.env.FISCAL_PARTNER_URL ?? '',
    fiscalPartnerToken: process.env.FISCAL_PARTNER_TOKEN ?? '',
    sefazAmbiente: (Number(process.env.SEFAZ_AMBIENTE ?? 2) === 1 ? 1 : 2) as 1 | 2,
    bankGateway: (process.env.BANK_GATEWAY ?? 'simulated') as Config['bankGateway'],
    webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET ?? 'dev-webhook-secret',
    aiProvider: (process.env.AI_PROVIDER ?? (!isTest && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) ? 'anthropic' : 'none')) as Config['aiProvider'],
    aiModel: process.env.AI_MODEL ?? 'claude-opus-5-5',
    provisioningKey: process.env.PROVISIONING_KEY ?? '',
    metricsToken: process.env.METRICS_TOKEN ?? '',
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 600),
    logLevel: process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug'),
    ...overrides,
  };
  if (cfg.env === 'production' && cfg.jwtSecret.length < 32) throw new Error('JWT_SECRET fraco para produção');
  if (cfg.env === 'production' && cfg.provisioningKey.length < 32) throw new Error('PROVISIONING_KEY ausente ou fraca para produção (mínimo 32 caracteres)');
  return cfg;
}
