import type { PdvConfig } from '../config.js';
import { LocalDb, migrate } from '../db/sqlite.js';
import { systemClock, type Clock } from '../clock.js';
import { Audit } from '../audit/audit.js';
import { Sealer } from '../security/crypto.js';
import { SyncQueue } from '../sync/queue.js';
import { SyncEngine } from '../sync/engine.js';
import { effectiveSettings } from '../sync/catalog.js';
import { HttpErpClient, type ErpClient } from '../erp/client.js';
import { ApiPixProvider, CashProvider, DisabledTef, ExternalPosProvider, SimulatedPixPsp, SimulatedTef, type PaymentProvider } from '../payment/providers.js';
import { PartnerFiscalProvider, SimulatedSefaz, type FiscalProvider } from '../fiscal/providers.js';
import { FiscalService } from '../fiscal/service.js';
import type { FiscalContext } from '../fiscal/tax.js';
import type { Issuer } from '../fiscal/nfce.js';
import { FilePrinter, NullPrinter, TcpPrinter, type PrinterDriver } from '../printer/drivers.js';
import { PrinterService } from '../printer/service.js';
import { MemoryDisplay, NoScale, SimulatedScale, TcpToledoScale, type CustomerDisplay, type Scale } from '../hardware/devices.js';
import type { PaymentMethod } from '../domain/payments.js';
import { AuthService } from './auth.js';
import { CatalogService } from './catalog.js';
import { CustomerService } from './customers.js';
import { CashService } from './cash.js';
import { SaleService } from './sales.js';
import { ReturnService } from './returns.js';
import { SystemService } from './system.js';

export interface PdvOverrides {
  clock?: Clock;
  erp?: ErpClient;
  fiscalProvider?: FiscalProvider;
  pix?: PaymentProvider;
  tef?: PaymentProvider;
  printer?: PrinterDriver;
  scale?: Scale;
  display?: CustomerDisplay;
}

/**
 * Monta o PDV (seção 45): UI → Application → Domain, com Local Database, Sync Engine,
 * ERP API Client, Payment, Fiscal, Printer, Hardware e Security. Integrações externas entram
 * por interface; sem configuração real, os simuladores são usados e identificados no status.
 */
export function createPdv(config: PdvConfig, o: PdvOverrides = {}) {
  const clock = o.clock ?? systemClock;
  const db = new LocalDb(config.dbPath);
  migrate(db);
  const sealer = new Sealer(config.secretKey);
  const terminalCode = config.terminalCode;
  const establishment = () => db.meta<Record<string, string>>('establishment');
  const establishmentId = () => config.erp.establishmentId || establishment()?.id || '';
  const settings = () => effectiveSettings(db);
  const audit = new Audit(db, () => terminalCode, clock);
  const queue = new SyncQueue(db, clock, config.sync.maxBackoffMs);
  const apiKey = () => config.erp.apiKey ?? (db.meta<string>('erp.apiKey') ? sealer.open(db.meta<string>('erp.apiKey')!) : null);
  const erp = o.erp ?? new HttpErpClient(config.erp.url, apiKey, establishmentId, config.erp.timeoutMs);

  // Pagamentos
  const pix = o.pix ?? (config.payment.pix === 'psp' ? new ApiPixProvider(config.payment.pspUrl, config.payment.pspToken, establishment()?.cnpj ?? '') : new SimulatedPixPsp(clock));
  const tef = o.tef ?? (config.payment.tef === 'none' ? new DisabledTef() : new SimulatedTef(clock));
  const pos = new ExternalPosProvider();
  const providers: Record<PaymentMethod, PaymentProvider> = { cash: new CashProvider(), pix, debit: tef, credit: tef, pos_debit: pos, pos_credit: pos };

  // Periféricos
  const driver = o.printer ?? (config.printer.driver === 'tcp' ? new TcpPrinter(config.printer.host, config.printer.port)
    : config.printer.driver === 'none' ? new NullPrinter() : new FilePrinter(config.dbPath === ':memory:' ? null : config.printer.spoolDir));
  const printer = new PrinterService(driver, () => settings().receipt.columns);
  const scale = o.scale ?? (config.scale.driver === 'tcp' ? new TcpToledoScale(config.scale.host, config.scale.port)
    : config.scale.driver === 'none' ? new NoScale() : new SimulatedScale());
  const display = o.display ?? new MemoryDisplay();

  // Fiscal
  const fiscalProvider = o.fiscalProvider ?? (config.fiscal.provider === 'partner' ? new PartnerFiscalProvider(config.fiscal.partnerUrl, config.fiscal.partnerToken) : new SimulatedSefaz(clock));
  const fiscalCtx = () => db.meta<FiscalContext>('fiscal.context');
  const issuer = (): Issuer | null => {
    const e = establishment();
    const ctx = fiscalCtx();
    if (!e || !ctx) return null;
    return { cnpj: e.cnpj!, legalName: e.legal_name!, tradeName: e.trade_name, ie: e.ie ?? '', uf: e.uf!, cityIbge: e.city_ibge!, cityName: e.city_name ?? '', street: e.street ?? '',
      number: e.number ?? 'S/N', district: e.district ?? '', zip: e.zip ?? '', phone: e.phone, regime: ctx.regime };
  };
  const fiscal = new FiscalService({
    db, provider: fiscalProvider, clock, audit, environment: config.fiscal.environment, csc: { id: config.fiscal.cscId, token: config.fiscal.csc }, terminalCode, settings, issuer,
    context: fiscalCtx,
    tPag: (code) => db.get<{ nfe_tpag: string }>(`SELECT nfe_tpag FROM payment_methods WHERE code = ?`, [code])?.nfe_tpag ?? '99',
    origin: (id) => fiscalCtx()?.products.find((p) => p.productId === id)?.origin ?? 0,
    cest: (id) => fiscalCtx()?.products.find((p) => p.productId === id)?.cest ?? null,
  });

  const auth = new AuthService(db, clock, audit, settings);
  const catalog = new CatalogService(db, clock, settings, establishmentId);
  const customers = new CustomerService(db, sealer, clock, queue, erp);
  const cash = new CashService({ db, clock, audit, queue, auth, settings, terminalCode, establishmentId, openDrawer: () => printer.openDrawer() });
  const store = () => {
    const e = establishment() ?? {};
    return { legalName: e.legal_name ?? 'Loja', tradeName: e.trade_name ?? null, cnpj: e.cnpj ?? '', ie: e.ie ?? null,
      address: [e.street, e.number, e.district, e.city_name && `${e.city_name}/${e.uf}`].filter(Boolean).join(', ') };
  };
  const sales = new SaleService({
    db, clock, audit, queue, auth, catalog, customers, cash, fiscal, printer, scale, display, providers, settings, terminalCode,
    merchant: () => ({ name: establishment()?.trade_name || establishment()?.legal_name || 'LOJA', city: establishment()?.city_name || 'CIDADE' }),
    receiptStore: store, environment: config.fiscal.environment,
  });
  const returns = new ReturnService({ db, clock, audit, queue, erp, auth, cash, customers, sales, providers, terminalCode, establishmentId });
  const system = new SystemService({ db, clock, queue, fiscal, fiscalProvider, printer, scale, providers, cash, erp, terminalCode, appVersion: config.appVersion, dbPath: config.dbPath });
  const sync = new SyncEngine({
    db, clock, queue, erp, audit, sealer, fiscal, sales, customers, settings, terminalCode, establishmentId, appVersion: config.appVersion, webhookSecret: config.webhookSecret,
    pullIntervalMs: config.sync.pullIntervalMs, health: () => system.health(),
  });

  return {
    config, clock, db, sealer, audit, queue, erp, providers, printer, scale, display, fiscalProvider, fiscal, auth, catalog, customers, cash, sales, returns, system, sync,
    settings, establishmentId,
    /** Pareamento: guarda a chave do terminal cifrada e faz a carga completa. */
    async pair(input: { apiKey: string; establishmentId: string }) {
      db.setMeta('erp.apiKey', sealer.seal(input.apiKey));
      db.setMeta('establishment', { ...(establishment() ?? {}), id: input.establishmentId });
      return sync.runOnce({ full: true });
    },
    close() {
      sync.stop();
      db.close();
    },
  };
}

export type Pdv = ReturnType<typeof createPdv>;
