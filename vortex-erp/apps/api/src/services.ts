import type { Config } from './config.js';
import { LocalImmutableStorage, type ObjectStorage } from './core/storage.js';
import { FakePublicLookup, HttpPublicLookup, type PublicLookup } from './core/lookups.js';
import { MemoryMailer, MemoryMessenger, type Mailer, type Messenger } from './core/mailer.js';
import { PartnerFiscalGateway, SimulatedFiscalGateway, type FiscalGateway } from './modules/fiscal-docs/gateway.js';
import { SimulatedBankGateway, type BankGateway } from './modules/finance/bank-gateway.js';
import { AnthropicAiModel, DisabledAiModel, type AiModel } from './modules/ai/model.js';

/** Serviços com ciclo de vida próprio (gateways externos, storage), injetáveis nos testes. */
export interface Services {
  storage: ObjectStorage;
  lookups: PublicLookup;
  fiscalGateway: FiscalGateway;
  bankGateway: BankGateway;
  mailer: Mailer;
  messenger: Messenger;
  ai: AiModel;
}

export function createServices(config: Config, overrides: Partial<Services> = {}): Services {
  return {
    storage: overrides.storage ?? new LocalImmutableStorage(config.storageDir),
    lookups: overrides.lookups ?? (config.env === 'test' ? new FakePublicLookup() : new HttpPublicLookup()),
    fiscalGateway: overrides.fiscalGateway ?? (config.fiscalGateway === 'partner' ? new PartnerFiscalGateway(config.fiscalPartnerUrl, config.fiscalPartnerToken) : new SimulatedFiscalGateway()),
    bankGateway: overrides.bankGateway ?? new SimulatedBankGateway(),
    mailer: overrides.mailer ?? new MemoryMailer(),
    messenger: overrides.messenger ?? new MemoryMessenger(),
    ai: overrides.ai ?? (config.aiProvider === 'anthropic' ? new AnthropicAiModel(config.aiModel) : new DisabledAiModel()),
  };
}
