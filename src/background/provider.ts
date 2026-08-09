import type { AppErrorCode } from '../shared/types';

export type ProviderErrorCode = Extract<
  AppErrorCode,
  'authentication' | 'rate_limit' | 'quota' | 'server' | 'network' | 'empty_response' | 'invalid_stream'
>;

export class ProviderFailure extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code);
    this.name = 'ProviderFailure';
  }
}

export interface StreamTranslationInput {
  apiKey: string;
  text: string;
  signal: AbortSignal;
  onChunk: (text: string) => void;
}

export interface TranslationProvider {
  stream(input: StreamTranslationInput): Promise<void>;
  testConnection(apiKey: string): Promise<void>;
}
