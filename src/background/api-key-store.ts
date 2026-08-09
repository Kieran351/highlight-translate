import { API_KEY_STORAGE_KEY } from '../shared/constants';

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class ApiKeyStore {
  constructor(private readonly storage: StorageAreaLike) {}

  async get(): Promise<string> {
    const result = await this.storage.get(API_KEY_STORAGE_KEY);
    const value = result[API_KEY_STORAGE_KEY];
    return typeof value === 'string' ? value : '';
  }

  async save(value: string): Promise<void> {
    const apiKey = value.trim();
    if (!apiKey) {
      await this.clear();
      return;
    }

    await this.storage.set({ [API_KEY_STORAGE_KEY]: apiKey });
  }

  async clear(): Promise<void> {
    await this.storage.remove(API_KEY_STORAGE_KEY);
  }
}
