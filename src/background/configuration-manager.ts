import type { ProviderId, ProviderModel, RequestConfiguration, SettingsSnapshot } from '../shared/types';
import type { ConfigurationStore } from './configuration-store';
import { ProviderFailure } from './provider';
import type { CatalogProvider } from './provider';

interface CatalogDraft {
  providerId: ProviderId;
  apiKey: string;
  models: ProviderModel[];
}

export interface ConfigurationManagerDependencies {
  store: ConfigurationStore;
  resolveProvider(providerId: ProviderId): CatalogProvider;
}

export class ConfigurationManager {
  private readonly drafts = new Map<string, CatalogDraft>();

  constructor(private readonly dependencies: ConfigurationManagerDependencies) {}

  read(): Promise<SettingsSnapshot> {
    return this.dependencies.store.read();
  }

  async refresh(providerId: ProviderId, key: string): Promise<{ models: ProviderModel[]; catalogToken: string; catalogSummary: { receivedCount: number; selectableCount: number } }> {
    const apiKey = key.trim();
    if (!apiKey) throw new ProviderFailure('invalid_configuration');
    const received = await this.dependencies.resolveProvider(providerId).listModels({
      apiKey, signal: AbortSignal.timeout(20_000),
    });
    const models = received.filter((model) => model.supportsText !== false);
    const catalogToken = crypto.randomUUID();
    this.drafts.set(catalogToken, { providerId, apiKey, models });
    return { models, catalogToken, catalogSummary: { receivedCount: received.length, selectableCount: models.length } };
  }

  private async catalog(providerId: ProviderId, apiKey: string, modelId: string, catalogToken?: string): Promise<ProviderModel[]> {
    const draft = catalogToken ? this.drafts.get(catalogToken) : undefined;
    const saved = (await this.read()).configurations[providerId];
    const models = draft?.providerId === providerId && draft.apiKey === apiKey ? draft.models
      : !catalogToken && saved?.apiKey === apiKey && saved.catalogStatus === 'ready' ? saved.models : undefined;
    if (!models?.some((model) => model.id === modelId && model.supportsText !== false)) {
      throw new ProviderFailure('invalid_configuration');
    }
    return models;
  }

  async save(providerId: ProviderId, key: string, modelId: string, catalogToken?: string): Promise<SettingsSnapshot> {
    const apiKey = key.trim();
    const models = await this.catalog(providerId, apiKey, modelId, catalogToken);
    return this.dependencies.store.update((snapshot) => {
      snapshot.configurations[providerId] = { apiKey, selectedModelId: modelId, models, catalogStatus: 'ready', selectionMissing: false };
      snapshot.activeProviderId = providerId;
    });
  }

  async clear(providerId: ProviderId): Promise<SettingsSnapshot> {
    const snapshot = await this.dependencies.store.update((settings) => {
      delete settings.configurations[providerId];
      if (settings.activeProviderId === providerId) settings.activeProviderId = null;
    });
    if (providerId === 'deepseek') await this.dependencies.store.clearLegacyKey();
    return snapshot;
  }

  async test(providerId: ProviderId, key: string, modelId: string, catalogToken?: string): Promise<void> {
    const apiKey = key.trim();
    await this.catalog(providerId, apiKey, modelId, catalogToken);
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
