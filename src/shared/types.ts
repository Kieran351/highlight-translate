export type LanguageRoute =
  | { kind: 'chinese'; label: '中文' }
  | { kind: 'known'; code: string; label: string }
  | { kind: 'unknown'; label: '自动检测' };

export type AppErrorCode =
  | 'invalid_request'
  | 'too_long'
  | 'missing_key'
  | 'invalid_configuration'
  | 'invalid_models'
  | 'unsupported_provider'
  | 'provider_unverified'
  | 'authentication'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'network'
  | 'empty_response'
  | 'invalid_stream'
  | 'timeout_models'
  | 'timeout_first'
  | 'timeout_idle'
  | 'timeout_total';

export interface ErrorPresentation {
  message: string;
  retryable: boolean;
  showSettings?: boolean;
}

export const PROVIDER_IDS = ['deepseek', 'minimax', 'glm', 'kimi', 'openai', 'anthropic'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export interface ProviderModel {
  id: string;
  name?: string;
  supportsText?: boolean;
}

export interface ProviderConfiguration {
  apiKey: string;
  selectedModelId: string | null;
  models: ProviderModel[];
  catalogStatus: 'unfetched' | 'ready';
  selectionMissing: boolean;
}

export interface SettingsSnapshot {
  activeProviderId: ProviderId | null;
  configurations: Partial<Record<ProviderId, ProviderConfiguration>>;
}

export interface RequestConfiguration {
  providerId: ProviderId;
  apiKey: string;
  modelId: string;
}
