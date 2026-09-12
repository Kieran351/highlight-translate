import type { AppErrorCode, ProviderId, ProviderModel, SettingsSnapshot } from './types';

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

export type SettingsMessage =
  | { type: 'get-settings' }
  | { type: 'refresh-models'; providerId: ProviderId; apiKey: string }
  | { type: 'save-settings'; providerId: ProviderId; apiKey: string; modelId: string; catalogToken?: string }
  | { type: 'clear-settings'; providerId: ProviderId }
  | { type: 'test-connection'; providerId: ProviderId; apiKey: string; modelId: string; catalogToken?: string };

export type ExtensionMessage = { type: 'open-options' } | SettingsMessage;

export type ExtensionResponse =
  | { ok: true }
  | { ok: false; message: string; code?: AppErrorCode };

export type SettingsResponse =
  | { ok: true; settings?: SettingsSnapshot; models?: ProviderModel[]; catalogToken?: string; catalogSummary?: { receivedCount: number; selectableCount: number } }
  | { ok: false; message: string; code?: AppErrorCode };
