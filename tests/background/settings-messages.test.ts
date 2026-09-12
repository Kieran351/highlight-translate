import { describe, expect, it, vi } from 'vitest';
import { ApiKeyStore } from '../../src/background/api-key-store';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { UI_TEXT } from '../../src/shared/ui-text';

const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };

function setup() {
  const values: Record<string, unknown> = {};
  const storage = {
    get: vi.fn(async () => ({ ...values })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const createHandler = () => createSettingsMessageHandler({
    extensionId: 'extension-id', extensionUrl: 'chrome-extension://extension-id/',
    store: new ApiKeyStore(storage), provider: new DeepSeekProvider(fetchImpl),
  });
  return { handle: createHandler(), createHandler, fetchImpl, storage };
}

describe('trusted settings messages', () => {
  it('reads, saves, reloads and clears the existing key without testing', async () => {
    const { handle, createHandler, fetchImpl } = setup();
    expect(await handle({ type: 'get-settings' }, sender)).toEqual({ ok: true, apiKey: '' });
    expect(await handle({ type: 'save-settings', apiKey: '  fake-key  ' }, sender)).toEqual({ ok: true });
    expect(await createHandler()({ type: 'get-settings' }, sender)).toEqual({ ok: true, apiKey: 'fake-key' });
    await handle({ type: 'clear-settings' }, sender);
    expect(await handle({ type: 'get-settings' }, sender)).toEqual({ ok: true, apiKey: '' });
    await handle({ type: 'save-settings', apiKey: 'fake-key' }, sender);
    await handle({ type: 'save-settings', apiKey: '   ' }, sender);
    expect(await handle({ type: 'get-settings' }, sender)).toEqual({ ok: true, apiKey: '' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tests draft credentials at the fixed official endpoint without changing saved settings', async () => {
    const { handle, fetchImpl } = setup();
    await handle({ type: 'save-settings', apiKey: 'saved-fake-key' }, sender);
    expect(await handle({ type: 'test-connection', apiKey: ' draft-fake-key ' }, sender)).toEqual({ ok: true });
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer draft-fake-key' });
    expect(JSON.parse(request?.body as string)).toMatchObject({ model: 'deepseek-v4-flash', messages: expect.arrayContaining([{ role: 'user', content: '你好' }]) });
    expect(await handle({ type: 'get-settings' }, sender)).toEqual({ ok: true, apiKey: 'saved-fake-key' });
  });

  it('rejects content pages, foreign callers and malformed payloads without side effects', async () => {
    const { handle, storage, fetchImpl } = setup();
    for (const caller of [{ ...sender, url: 'https://example.com' }, { ...sender, id: 'other' }, { ...sender, url: 'chrome-extension://extension-id.evil/options.html' }]) {
      for (const message of [{ type: 'get-settings' }, { type: 'save-settings', apiKey: 'fake-key' }, { type: 'clear-settings' }, { type: 'test-connection', apiKey: 'fake-key' }]) {
        expect(await handle(message, caller)).toBeUndefined();
      }
    }
    for (const message of [null, [], { type: 'save-settings', apiKey: 3 }, { type: 'test-connection', apiKey: 'fake-key', url: 'https://evil.test' }, { type: 'get-settings', text: 'private selection' }]) {
      expect(await handle(message, sender)).toBeUndefined();
    }
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns safe storage and provider errors', async () => {
    const { handle, storage, fetchImpl } = setup();
    storage.get.mockRejectedValueOnce(new Error('secret storage detail'));
    expect(await handle({ type: 'get-settings' }, sender)).toEqual({ ok: false, message: UI_TEXT.settingsReadFailed });
    storage.set.mockRejectedValueOnce(new Error('secret storage detail'));
    expect(await handle({ type: 'save-settings', apiKey: 'fake-key' }, sender)).toEqual({ ok: false, message: UI_TEXT.keySaveFailed });
    storage.remove.mockRejectedValueOnce(new Error('secret storage detail'));
    expect(await handle({ type: 'clear-settings' }, sender)).toEqual({ ok: false, message: UI_TEXT.keyClearFailed });
    expect(await handle({ type: 'test-connection', apiKey: ' ' }, sender)).toEqual({ ok: false, message: UI_TEXT.enterKeyBeforeTest });
    fetchImpl.mockResolvedValueOnce(new Response('secret response', { status: 401 }));
    const response = await handle({ type: 'test-connection', apiKey: 'fake-key' }, sender);
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toMatch(/secret|fake-key/);
  });
});
