import type { ProviderId } from '../shared/types';
import { DeepSeekProvider } from './deepseek-provider';
import { MiniMaxProvider } from './minimax-provider';
import { KimiProvider } from './kimi-provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { ProviderFailure } from './provider';
import type { CatalogProvider } from './provider';

type FetchLike = typeof fetch;
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export function createProviderRegistry(fetchImpl: FetchLike = defaultFetch): (id: ProviderId) => CatalogProvider {
  const providers: Partial<Record<ProviderId, CatalogProvider>> = {
    deepseek: new DeepSeekProvider(fetchImpl),
    minimax: new MiniMaxProvider(fetchImpl),
    kimi: new KimiProvider(fetchImpl),
    openai: new OpenAIProvider(fetchImpl),
    anthropic: new AnthropicProvider(fetchImpl),
  };
  return (id) => {
    const provider = providers[id];
    if (!provider) throw new ProviderFailure('provider_unverified');
    return provider;
  };
}

export const resolveProvider = createProviderRegistry();
