import type { ApiKeyStore } from './api-key-store';
import type { DeepSeekProvider } from './deepseek-provider';
import { ProviderFailure } from './provider';
import { getErrorPresentation } from '../shared/errors';
import type { SettingsMessage, SettingsResponse } from '../shared/messages';
import { UI_TEXT } from '../shared/ui-text';

interface SettingsDependencies {
  extensionId: string;
  extensionUrl: string;
  store: Pick<ApiKeyStore, 'get' | 'save' | 'clear'>;
  provider: Pick<DeepSeekProvider, 'testConnection'>;
}

function isSettingsMessage(value: unknown): value is SettingsMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('type' in value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (value.type === 'get-settings' || value.type === 'clear-settings') {
    return keys.length === 1;
  }
  return (value.type === 'save-settings' || value.type === 'test-connection')
    && keys.length === 2 && 'apiKey' in value && typeof value.apiKey === 'string';
}

export function createSettingsMessageHandler(dependencies: SettingsDependencies) {
  return async (message: unknown, sender: chrome.runtime.MessageSender): Promise<SettingsResponse | undefined> => {
    if (sender.id !== dependencies.extensionId || !sender.url?.startsWith(dependencies.extensionUrl)
      || !isSettingsMessage(message)) {
      return undefined;
    }

    try {
      switch (message.type) {
        case 'get-settings':
          return { ok: true, apiKey: await dependencies.store.get() };
        case 'save-settings':
          await dependencies.store.save(message.apiKey);
          return { ok: true };
        case 'clear-settings':
          await dependencies.store.clear();
          return { ok: true };
        case 'test-connection':
          if (!message.apiKey.trim()) {
            return { ok: false, message: UI_TEXT.enterKeyBeforeTest };
          }
          await dependencies.provider.testConnection(message.apiKey.trim());
          return { ok: true };
      }
    } catch (error: unknown) {
      const messages = {
        'get-settings': UI_TEXT.settingsReadFailed,
        'save-settings': UI_TEXT.keySaveFailed,
        'clear-settings': UI_TEXT.keyClearFailed,
        'test-connection': getErrorPresentation(error instanceof ProviderFailure ? error.code : 'network').message,
      };
      return { ok: false, message: messages[message.type] };
    }
  };
}
