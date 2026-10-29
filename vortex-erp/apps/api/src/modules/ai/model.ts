import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** Parâmetros da chamada; modelo, betas e fallback ficam por conta do serviço. */
export type AiRequest = Omit<MessageCreateParamsNonStreaming, 'model' | 'betas' | 'fallbacks' | 'stream'>;
export type AiResponse = BetaMessage;

/**
 * Modelo de linguagem usado pela IA do ERP. A regra da casa (seção 20): a IA sugere, a regra
 * valida e o humano confirma; se o modelo estiver indisponível, cada funcionalidade tem um
 * caminho determinístico (fail-open para o usuário, fail-safe para os dados).
 */
export interface AiModel {
  readonly provider: string;
  readonly model: string;
  available(): boolean;
  create(req: AiRequest): Promise<AiResponse>;
}

export class AnthropicAiModel implements AiModel {
  readonly provider = 'anthropic';
  private readonly client: Anthropic;

  constructor(readonly model: string) {
    // Credenciais vêm de ANTHROPIC_API_KEY (ou ANTHROPIC_AUTH_TOKEN) no ambiente
    this.client = new Anthropic({ maxRetries: 2, timeout: 120_000 });
  }

  available() {
    return true;
  }

  async create(req: AiRequest): Promise<AiResponse> {
    // Fallback no servidor: se o modelo principal estiver sobrecarregado, a API tenta o substituto padrão
    return this.client.beta.messages.create({ ...req, model: this.model, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  }
}

/** Sem chave configurada (ou em teste): a IA fica desligada e as funcionalidades usam as regras. */
export class DisabledAiModel implements AiModel {
  readonly provider = 'none';
  readonly model = 'none';
  available() {
    return false;
  }
  async create(): Promise<AiResponse> {
    throw new Error('IA desabilitada');
  }
}

/** Preço por milhão de tokens (USD) para o registro de custo (RN-IA-02). */
export const AI_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function aiCost(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const p = AI_PRICES[model] ?? AI_PRICES[Object.keys(AI_PRICES).find((k) => model.startsWith(k)) ?? ''] ?? AI_PRICES['claude-opus-5-5']!;
  return (u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1_000_000;
}
