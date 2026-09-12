import type { ConfigurationManager } from './configuration-manager';
import { ProviderFailure } from './provider';
import { getErrorPresentation } from '../shared/errors';
import type { SettingsMessage, SettingsResponse } from '../shared/messages';
import { PROVIDER_IDS } from '../shared/types';
import { UI_TEXT } from '../shared/ui-text';

interface SettingsDependencies {
  extensionId: string;
  extensionUrl: string;
  manager: ConfigurationManager;
}

function isSettingsMessage(value: unknown): value is SettingsMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('type' in value)) return false;
  const keys = Object.keys(value);
  if (value.type === 'get-settings') return keys.length === 1;
  if (!('providerId' in value) || !PROVIDER_IDS.some((id) => id === value.providerId)) return false;
  if (value.type === 'clear-settings') return keys.length === 2;
  if (!('apiKey' in value) || typeof value.apiKey !== 'string') return false;
  if (value.type === 'refresh-models') return keys.length === 3;
  return (value.type === 'save-settings' || value.type === 'test-connection')
    && 'modelId' in value && typeof value.modelId === 'string'
    && keys.every((key) => ['type', 'providerId', 'apiKey', 'modelId', 'catalogToken'].includes(key))
    && (!('catalogToken' in value) || typeof value.catalogToken === 'string');
}

export function createSettingsMessageHandler(dependencies: SettingsDependencies) {
  return async (message: unknown, sender: chrome.runtime.MessageSender): Promise<SettingsResponse | undefined> => {
    if (sender.id !== dependencies.extensionId || !sender.url?.startsWith(dependencies.extensionUrl)
      || !isSettingsMessage(message)) return undefined;

    try {
      const { manager } = dependencies;
      switch (message.type) {
        case 'get-settings':
          return { ok: true, settings: await manager.read() };
        case 'refresh-models':
          return { ok: true, ...await manager.refresh(message.providerId, message.apiKey) };
        case 'save-settings':
          return { ok: true, settings: await manager.save(message.providerId, message.apiKey, message.modelId, message.catalogToken) };
        case 'clear-settings':
          return { ok: true, settings: await manager.clear(message.providerId) };
        case 'test-connection':
          await manager.test(message.providerId, message.apiKey, message.modelId, message.catalogToken);
          return { ok: true };
      }
    } catch (error: unknown) {
      if (error instanceof ProviderFailure) {
        return { ok: false, code: error.code, message: getErrorPresentation(error.code).message };
      }
      const messages = {
        'get-settings': UI_TEXT.settingsReadFailed,
        'save-settings': UI_TEXT.keySaveFailed,
        'clear-settings': UI_TEXT.keyClearFailed,
        'refresh-models': getErrorPresentation('network').message,
        'test-connection': getErrorPresentation('network').message,
      };
      return { ok: false, message: messages[message.type] };
    }
  };
}
