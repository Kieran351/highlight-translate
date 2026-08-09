import type { AppErrorCode } from './types';

export type ClientPortMessage =
  | { type: 'translate'; requestId: string; text: string }
  | { type: 'cancel'; requestId: string };

export type ServerPortMessage =
  | { type: 'route'; requestId: string; direction: string; local: boolean }
  | { type: 'chunk'; requestId: string; text: string }
  | { type: 'complete'; requestId: string }
  | {
      type: 'error';
      requestId: string;
      code: AppErrorCode;
      message: string;
      retryable: boolean;
      partial: boolean;
      showSettings?: boolean;
    }
  | { type: 'cancelled'; requestId: string };

export type ExtensionMessage =
  | { type: 'open-options' }
  | { type: 'test-connection'; apiKey: string };

export type ExtensionResponse =
  | { ok: true }
  | { ok: false; message: string };
