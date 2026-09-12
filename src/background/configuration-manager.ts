import type { ProviderId, ProviderModel, RequestConfiguration, SettingsSnapshot } from '../shared/types';
import type { ConfigurationStore } from './configuration-store';
import { ProviderFailure } from './provider';
import type { CatalogProvider } from './provider';

interface CatalogDraft {
  token: string;
  apiKey: string;
  models: ProviderModel[];
}

export interface ConfigurationManagerDependencies {
  store: ConfigurationStore;
  resolveProvider(providerId: ProviderId): CatalogProvider;
}

export class ConfigurationManager {
  private readonly drafts = new Map<ProviderId, CatalogDraft>();
  private readonly attempts = new Map<ProviderId, number>();
  private readonly credentialVersions = new Map<ProviderId, number>();

  constructor(private readonly dependencies: ConfigurationManagerDependencies) {}

  read(): Promise<SettingsSnapshot> {
    return this.dependencies.store.read();
  }

  async refresh(providerId: ProviderId, key: string): Promise<{ models: ProviderModel[]; catalogToken: string; catalogSummary: { receivedCount: number; selectableCount: number }; settings: SettingsSnapshot }> {
    const apiKey = key.trim();
    if (!apiKey) throw new ProviderFailure('invalid_configuration');
    let attempt = 0;
    let credentialVersion = 0;
    await this.dependencies.store.update(() => {
      attempt = (this.attempts.get(providerId) ?? 0) + 1;
      this.attempts.set(providerId, attempt);
      credentialVersion = this.credentialVersions.get(providerId) ?? 0;
      if (this.drafts.get(providerId)?.apiKey !== apiKey) this.drafts.delete(providerId);
      return false;
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let received: ProviderModel[];
    try {
      received = await Promise.race([
        this.dependencies.resolveProvider(providerId).listModels({ apiKey, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ProviderFailure('timeout_models'));
            controller.abort();
          }, 20_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const models = received.filter((model) => model.supportsText !== false);
    const catalogToken = crypto.randomUUID();
    const settings = await this.dependencies.store.update((snapshot) => {
      if (this.attempts.get(providerId) !== attempt
        || (this.credentialVersions.get(providerId) ?? 0) !== credentialVersion) {
        throw new ProviderFailure('invalid_configuration');
      }
      const saved = snapshot.configurations[providerId];
      if (!saved || saved.apiKey !== apiKey) return false;
      saved.models = models;
      saved.catalogStatus = 'ready';
      saved.selectionMissing = saved.selectedModelId !== null && !models.some((model) => model.id === saved.selectedModelId);
    }, () => {
      this.drafts.set(providerId, { token: catalogToken, apiKey, models });
    });
    return { models, catalogToken, settings, catalogSummary: { receivedCount: received.length, selectableCount: models.length } };
  }

  private catalog(settings: SettingsSnapshot, providerId: ProviderId, apiKey: string, modelId: string, catalogToken?: string): ProviderModel[] {
    const draft = this.drafts.get(providerId);
    const saved = settings.configurations[providerId];
    const models = catalogToken && draft?.token === catalogToken && draft.apiKey === apiKey ? draft.models
      : !catalogToken && saved?.apiKey === apiKey && saved.catalogStatus === 'ready' ? saved.models : undefined;
    if (!models?.some((model) => model.id === modelId && model.supportsText !== false)) {
      throw new ProviderFailure('invalid_configuration');
    }
    return models;
  }

  async save(providerId: ProviderId, key: string, modelId: string, catalogToken?: string): Promise<SettingsSnapshot> {
    const apiKey = key.trim();
    let changedKey = false;
    return this.dependencies.store.update((snapshot) => {
      const models = this.catalog(snapshot, providerId, apiKey, modelId, catalogToken);
      changedKey = snapshot.configurations[providerId]?.apiKey !== apiKey;
      snapshot.configurations[providerId] = { apiKey, selectedModelId: modelId, models, catalogStatus: 'ready', selectionMissing: false };
      snapshot.activeProviderId = providerId;
    }, () => {
      if (changedKey) this.credentialVersions.set(providerId, (this.credentialVersions.get(providerId) ?? 0) + 1);
    });
  }

  async clear(providerId: ProviderId): Promise<SettingsSnapshot> {
    const snapshot = await this.dependencies.store.update((settings) => {
      delete settings.configurations[providerId];
      if (settings.activeProviderId === providerId) settings.activeProviderId = null;
    }, () => {
      this.credentialVersions.set(providerId, (this.credentialVersions.get(providerId) ?? 0) + 1);
      this.drafts.delete(providerId);
    });
    if (providerId === 'deepseek') await this.dependencies.store.clearLegacyKey();
    return snapshot;
  }

  async test(providerId: ProviderId, key: string, modelId: string, catalogToken?: string): Promise<void> {
    const apiKey = key.trim();
    await this.dependencies.store.update((snapshot) => {
      this.catalog(snapshot, providerId, apiKey, modelId, catalogToken);
      return false;
    });
    await this.dependencies.resolveProvider(providerId).testConnection(apiKey, modelId);
  }

  async requestConfiguration(): Promise<RequestConfiguration | null> {
    const settings = await this.read();
    const providerId = settings.activeProviderId;
    const configuration = providerId ? settings.configurations[providerId] : undefined;
    if (!providerId || !configuration?.apiKey || !configuration.selectedModelId
      || configuration.catalogStatus !== 'ready' || configuration.selectionMissing
      || !configuration.models.some((model) => model.id === configuration.selectedModelId && model.supportsText !== false)) return null;
    return { providerId, apiKey: configuration.apiKey, modelId: configuration.selectedModelId };
  }
}
