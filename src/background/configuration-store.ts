import { API_KEY_STORAGE_KEY } from '../shared/constants';
import { PROVIDER_IDS } from '../shared/types';
import type { ProviderConfiguration, SettingsSnapshot } from '../shared/types';
import type { StorageAreaLike } from './api-key-store';

const CONFIGURATION_STORAGE_KEY = 'providerConfigurations';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfiguration(value: unknown): ProviderConfiguration {
  if (!isRecord(value) || typeof value.apiKey !== 'string'
    || (value.selectedModelId !== null && typeof value.selectedModelId !== 'string')
    || (value.catalogStatus !== 'ready' && value.catalogStatus !== 'unfetched')
    || typeof value.selectionMissing !== 'boolean' || !Array.isArray(value.models)) {
    throw new Error('Invalid saved configuration');
  }
  const models = value.models.map((model: unknown) => {
    if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()
      || (model.name !== undefined && typeof model.name !== 'string')
      || (model.supportsText !== undefined && typeof model.supportsText !== 'boolean')) {
      throw new Error('Invalid saved model');
    }
    return { id: model.id, ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.supportsText === undefined ? {} : { supportsText: model.supportsText }) };
  });
  return { apiKey: value.apiKey, selectedModelId: value.selectedModelId, models,
    catalogStatus: value.catalogStatus, selectionMissing: value.selectionMissing };
}

export class ConfigurationStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: StorageAreaLike) {}

  async read(): Promise<SettingsSnapshot> {
    await this.writes;
    return this.readStored();
  }

  private async readStored(): Promise<SettingsSnapshot> {
    const stored = (await this.storage.get(CONFIGURATION_STORAGE_KEY))[CONFIGURATION_STORAGE_KEY];
    if (stored !== undefined) {
      if (!isRecord(stored) || !isRecord(stored.configurations)
        || (stored.activeProviderId !== null && !PROVIDER_IDS.some((id) => id === stored.activeProviderId))) {
        throw new Error('Invalid saved settings');
      }
      const snapshot: SettingsSnapshot = { activeProviderId: stored.activeProviderId as SettingsSnapshot['activeProviderId'], configurations: {} };
      for (const id of PROVIDER_IDS) {
        if (stored.configurations[id] !== undefined) {
          snapshot.configurations[id] = readConfiguration(stored.configurations[id]);
        }
      }
      return snapshot;
    }
    const legacy = (await this.storage.get(API_KEY_STORAGE_KEY))[API_KEY_STORAGE_KEY];
    const apiKey = typeof legacy === 'string' ? legacy.trim() : '';
    return { activeProviderId: apiKey ? 'deepseek' : null, configurations: apiKey ? {
      deepseek: { apiKey, selectedModelId: null, models: [], catalogStatus: 'unfetched', selectionMissing: false },
    } : {} };
  }

  update(change: (snapshot: SettingsSnapshot) => void | boolean): Promise<SettingsSnapshot> {
    const operation = this.writes.then(async () => {
      const snapshot = await this.readStored();
      if (change(snapshot) === false) return snapshot;
      await this.storage.set({ [CONFIGURATION_STORAGE_KEY]: snapshot });
      return snapshot;
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  async clearLegacyKey(): Promise<void> {
    await this.storage.remove(API_KEY_STORAGE_KEY);
  }
}
