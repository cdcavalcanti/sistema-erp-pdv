/**
 * Configuração do agente do terminal (variáveis de ambiente; espelhadas em apps/pdv/.env.example).
 * Nada de segredo no código: a chave de API do terminal e a chave de cifra local vêm do ambiente
 * ou do pareamento (`pnpm --filter @vortex/pdv pair`), que grava a chave cifrada no banco local.
 */
export interface PdvConfig {
  env: 'development' | 'test' | 'production';
  /** Porta da API local consumida pela frente de caixa (sempre em 127.0.0.1) */
  port: number;
  host: string;
  /** Origem da interface (CORS); em produção a interface é servida pelo próprio agente */
  uiOrigin: string;
  dbPath: string;
  /** Chave de 32 bytes (base64) para cifrar dados sensíveis no banco local */
  secretKey: Buffer;
  erp: {
    url: string;
    apiKey: string | null;
    establishmentId: string;
    timeoutMs: number;
  };
  terminalCode: string;
  appVersion: string;
  sync: { intervalMs: number; pullIntervalMs: number; heartbeatMs: number; maxBackoffMs: number };
  /** Segredo dos webhooks do ERP (HMAC-SHA256); vazio desliga o recebimento */
  webhookSecret: string;
  fiscal: {
    provider: 'simulated' | 'partner';
    partnerUrl: string;
    partnerToken: string;
    /** 1 = produção, 2 = homologação */
    environment: 1 | 2;
    /** CSC (código de segurança do contribuinte) para o QR Code da NFC-e */
    cscId: string;
    csc: string;
  };
  payment: {
    pix: 'simulated' | 'psp';
    /** TEF integrado: simulador de homologação ou desligado (cartão só pela maquininha avulsa) */
    tef: 'simulated' | 'none';
    pspUrl: string;
    pspToken: string;
  };
  printer: { driver: 'file' | 'tcp' | 'none'; host: string; port: number; spoolDir: string };
  /** Balança: simulada, Toledo por TCP (conversor serial-Ethernet ou ser2net) ou nenhuma */
  scale: { driver: 'simulated' | 'tcp' | 'none'; host: string; port: number };
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

export function loadConfig(overrides: Partial<PdvConfig> = {}): PdvConfig {
  const env = (process.env.NODE_ENV ?? 'development') as PdvConfig['env'];
  const dev = env !== 'production';
  const key = Buffer.from(required('PDV_SECRET_KEY', dev ? 'cGR2LWRldi1rZXktcGR2LWRldi1rZXktcGR2LWRldjE=' : undefined), 'base64');
  if (key.length !== 32) throw new Error('PDV_SECRET_KEY deve ter 32 bytes em base64');
  const cfg: PdvConfig = {
    env,
    port: Number(process.env.PDV_PORT ?? 4545),
    host: process.env.PDV_HOST ?? '127.0.0.1',
    uiOrigin: process.env.PDV_UI_ORIGIN ?? 'http://localhost:5174',
    dbPath: process.env.PDV_DB_PATH ?? './data/pdv.sqlite',
    secretKey: key,
    erp: {
      url: required('PDV_ERP_URL', dev ? 'http://localhost:3333' : undefined),
      apiKey: process.env.PDV_ERP_API_KEY || null,
      establishmentId: process.env.PDV_STORE_ID ?? '',
      timeoutMs: Number(process.env.PDV_ERP_TIMEOUT_MS ?? 8000),
    },
    terminalCode: process.env.PDV_TERMINAL_CODE ?? '01',
    appVersion: process.env.PDV_APP_VERSION ?? '1.0.0',
    sync: {
      intervalMs: Number(process.env.PDV_SYNC_INTERVAL_MS ?? 30_000),
      pullIntervalMs: Number(process.env.PDV_PULL_INTERVAL_MS ?? 60_000),
      heartbeatMs: Number(process.env.PDV_HEARTBEAT_MS ?? 60_000),
      maxBackoffMs: Number(process.env.PDV_SYNC_MAX_BACKOFF_MS ?? 600_000),
    },
    webhookSecret: process.env.PDV_WEBHOOK_SECRET ?? '',
    fiscal: {
      provider: (process.env.PDV_FISCAL_PROVIDER ?? 'simulated') as PdvConfig['fiscal']['provider'],
      partnerUrl: process.env.PDV_FISCAL_PARTNER_URL ?? '',
      partnerToken: process.env.PDV_FISCAL_PARTNER_TOKEN ?? '',
      environment: Number(process.env.PDV_SEFAZ_AMBIENTE ?? 2) === 1 ? 1 : 2,
      cscId: process.env.PDV_NFCE_CSC_ID ?? '000001',
      csc: process.env.PDV_NFCE_CSC ?? (dev ? 'CSC-HOMOLOGACAO-0000000000000000' : ''),
    },
    payment: {
      pix: (process.env.PDV_PIX_PROVIDER ?? 'simulated') as PdvConfig['payment']['pix'],
      tef: (process.env.PDV_TEF_PROVIDER ?? 'simulated') as PdvConfig['payment']['tef'],
      pspUrl: process.env.PDV_PIX_PSP_URL ?? '',
      pspToken: process.env.PDV_PIX_PSP_TOKEN ?? '',
    },
    printer: {
      driver: (process.env.PDV_PRINTER ?? 'file') as PdvConfig['printer']['driver'],
      host: process.env.PDV_PRINTER_HOST ?? '127.0.0.1',
      port: Number(process.env.PDV_PRINTER_PORT ?? 9100),
      spoolDir: process.env.PDV_PRINTER_SPOOL ?? './data/spool',
    },
    scale: {
      driver: (process.env.PDV_SCALE ?? 'simulated') as PdvConfig['scale']['driver'],
      host: process.env.PDV_SCALE_HOST ?? '127.0.0.1',
      port: Number(process.env.PDV_SCALE_PORT ?? 4001),
    },
    ...overrides,
  };
  if (cfg.env === 'production') {
    if (cfg.fiscal.environment === 1 && cfg.fiscal.provider === 'simulated') throw new Error('Emissão em produção exige provedor fiscal real (PDV_FISCAL_PROVIDER=partner)');
    if (!cfg.erp.establishmentId) throw new Error('PDV_STORE_ID (estabelecimento no ERP) é obrigatório em produção');
    if (!cfg.fiscal.csc) throw new Error('PDV_NFCE_CSC é obrigatório em produção');
    if (cfg.fiscal.environment === 1 && cfg.payment.pix === 'simulated') throw new Error('Pix simulado não pode operar com emissão em produção (PDV_PIX_PROVIDER=psp)');
    if (cfg.fiscal.environment === 1 && cfg.payment.tef === 'simulated') throw new Error('TEF simulado não pode operar com emissão em produção (PDV_TEF_PROVIDER=none e cartão pela maquininha)');
  }
  return cfg;
}
