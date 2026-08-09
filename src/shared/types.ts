export type LanguageRoute =
  | { kind: 'chinese'; label: '中文' }
  | { kind: 'known'; code: string; label: string }
  | { kind: 'unknown'; label: '自动检测' };

export type AppErrorCode =
  | 'invalid_request'
  | 'too_long'
  | 'missing_key'
  | 'authentication'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'network'
  | 'empty_response'
  | 'invalid_stream'
  | 'timeout_first'
  | 'timeout_idle'
  | 'timeout_total';

export interface ErrorPresentation {
  message: string;
  retryable: boolean;
  showSettings?: boolean;
}
