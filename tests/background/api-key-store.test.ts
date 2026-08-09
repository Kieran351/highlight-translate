import { describe, expect, it, vi } from 'vitest';

import { ApiKeyStore } from '../../src/background/api-key-store';

describe('API key store', () => {
  it('trims and stores a key locally', async () => {
    const storage = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const store = new ApiKeyStore(storage);

    await store.save('  secret-key  ');

    expect(storage.set).toHaveBeenCalledWith({ deepseekApiKey: 'secret-key' });
  });

  it('clears storage instead of saving a blank key', async () => {
    const storage = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const store = new ApiKeyStore(storage);

    await store.save('   ');

    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith('deepseekApiKey');
  });
});
