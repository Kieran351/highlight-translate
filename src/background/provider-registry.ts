import type { ProviderId } from '../shared/types';
import { DeepSeekProvider } from './deepseek-provider';
import { ProviderFailure } from './provider';
import type { CatalogProvider } from './provider';

type FetchLike = typeof fetch;
const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export function createProviderRegistry(fetchImpl: FetchLike = defaultFetch): (id: ProviderId) => CatalogProvider {
  const providers: Partial<Record<ProviderId, CatalogProvider>> = {
    deepseek: new DeepSeekProvider(fetchImpl),
  };
  return (id) => {
    const provider = providers[id];
    if (!provider) throw new ProviderFailure('provider_unverified');
    return provider;
  };
}

export const resolveProvider = createProviderRegistry();
