import type { AppErrorCode, ProviderModel } from '../shared/types';

export type ProviderErrorCode = Extract<
  AppErrorCode,
  'authentication' | 'rate_limit' | 'quota' | 'server' | 'network' | 'empty_response' | 'invalid_stream' | 'invalid_models' | 'unsupported_provider' | 'provider_unverified' | 'invalid_configuration' | 'catalog_expired' | 'timeout_models' | 'timeout_test'
>;

export class ProviderFailure extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code);
    this.name = 'ProviderFailure';
  }
}

export interface StreamTranslationInput {
  apiKey: string;
  modelId?: string;
  text: string;
  signal: AbortSignal;
  onChunk: (text: string) => void;
}

export interface TranslationProvider {
  stream(input: StreamTranslationInput): Promise<void>;
  testConnection(apiKey: string, modelId?: string): Promise<void>;
}

export interface ListModelsInput {
  apiKey: string;
  signal: AbortSignal;
}

export interface CatalogProvider extends TranslationProvider {
  listModels(input: ListModelsInput): Promise<ProviderModel[]>;
}
