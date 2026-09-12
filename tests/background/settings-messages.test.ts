import { describe, expect, it, vi } from 'vitest';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { UI_TEXT } from '../../src/shared/ui-text';

const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };

function setup() {
  const values: Record<string, unknown> = {};
  const storage = {
    get: vi.fn(async () => structuredClone(values)),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: 'api-model' }] }));
  const manager = new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider: () => new DeepSeekProvider(fetchImpl) });
  const handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', manager });
  return { handle, fetchImpl, storage };
}

describe('trusted settings messages', () => {
  it('clears a saved configuration and preserves the operation after reload', async () => {
    const { handle } = setup();
    const catalog = await handle({ type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' }, sender);
    if (!catalog?.ok) throw new Error('Expected catalog');
    await handle({ type: 'save-settings', providerId: 'deepseek', apiKey: 'fake-key', modelId: 'api-model', catalogToken: catalog.catalogToken }, sender);
    expect(await handle({ type: 'clear-settings', providerId: 'deepseek' }, sender)).toMatchObject({ ok: true, settings: { activeProviderId: null, configurations: {} } });
    expect(await handle({ type: 'get-settings' }, sender)).toMatchObject({ ok: true, settings: { configurations: {} } });
  });

  it('tests draft credentials with a listed model without changing saved settings', async () => {
    const { handle, fetchImpl } = setup();
    const catalog = await handle({ type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' }, sender);
    if (!catalog?.ok) throw new Error('Expected catalog');
    fetchImpl.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'));
    expect(await handle({ type: 'test-connection', providerId: 'deepseek', apiKey: 'fake-key', modelId: 'api-model', catalogToken: catalog.catalogToken }, sender)).toEqual({ ok: true });
    const [url, request] = fetchImpl.mock.calls[1]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
    expect(JSON.parse(request?.body as string)).toMatchObject({ model: 'api-model', messages: expect.arrayContaining([{ role: 'user', content: 'Hello, world!' }]) });
    expect(await handle({ type: 'get-settings' }, sender)).toMatchObject({ ok: true, settings: { activeProviderId: null } });
  });

  it('rejects content pages, foreign callers and malformed payloads without side effects', async () => {
    const { handle, storage, fetchImpl } = setup();
    for (const caller of [{ ...sender, url: 'https://example.com' }, { ...sender, id: 'other' }, { ...sender, url: 'chrome-extension://extension-id.evil/options.html' }]) {
      for (const message of [{ type: 'get-settings' }, { type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' }, { type: 'clear-settings', providerId: 'deepseek' }]) {
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
    fetchImpl.mockResolvedValueOnce(new Response('secret response', { status: 401 }));
    const response = await handle({ type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' }, sender);
    expect(response).toMatchObject({ ok: false, code: 'authentication' });
    expect(JSON.stringify(response)).not.toMatch(/secret|fake-key/);
  });
});
