import { describe, expect, it, vi } from 'vitest';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';
import type { SettingsResponse } from '../../src/shared/messages';

const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };

function setup(legacy = '') {
  const values: Record<string, unknown> = { deepseekApiKey: legacy };
  const storage = {
    get: vi.fn(async () => structuredClone(values)),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response('data: {"choices":[{"delta":{"content":"译文"}}]}\n\ndata: [DONE]\n\n')
    : Response.json({ data: [{ id: 'future-text-model' }, { id: 'multimodal' }] }));
  const provider = new DeepSeekProvider(fetchImpl);
  const makeManager = () => new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider: () => provider });
  const manager = makeManager();
  const makeHandler = (configuration = manager) => createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', manager: configuration });
  return { manager, makeManager, handle: makeHandler(), makeHandler, fetchImpl, storage, provider };
}

function success(response: SettingsResponse | undefined) {
  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected successful settings response');
  return response;
}

describe('dynamic provider configuration through messages', () => {
  it('preserves a legacy key without manufacturing an API-verified model', async () => {
    const { handle, manager, fetchImpl } = setup('legacy-fake-key');
    const read = success(await handle({ type: 'get-settings' }, sender));
    expect(read.settings?.configurations.deepseek).toMatchObject({ apiKey: 'legacy-fake-key', selectedModelId: null, models: [], catalogStatus: 'unfetched' });
    expect(await manager.requestConfiguration()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches the official catalog, saves without testing, reloads and streams the selected model', async () => {
    const { handle, makeHandler, makeManager, manager, provider, fetchImpl } = setup();
    const catalog = success(await handle({ type: 'refresh-models', providerId: 'deepseek', apiKey: ' fake-key ' }, sender));
    expect(catalog.models).toContainEqual({ id: 'future-text-model' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/models');
    expect(await manager.requestConfiguration()).toBeNull();
    success(await handle({ type: 'save-settings', providerId: 'deepseek', apiKey: 'fake-key', modelId: 'future-text-model', catalogToken: catalog.catalogToken }, sender));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const reread = success(await makeHandler(makeManager())({ type: 'get-settings' }, sender));
    expect(reread.settings?.activeProviderId).toBe('deepseek');
    expect(reread.settings?.configurations.deepseek?.selectedModelId).toBe('future-text-model');
    const port = new FakePort();
    createTranslationSession(port, { detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }), getRequestConfiguration: () => manager.requestConfiguration(), streamTranslation: (input) => provider.stream(input) });
    port.onMessage.emit({ type: 'translate', requestId: 'request-1', text: 'Only the selected sentence.' });
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'complete', requestId: 'request-1' }));
    const [url, request] = fetchImpl.mock.calls[1]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
    expect(JSON.parse(request?.body as string)).toMatchObject({ model: 'future-text-model', messages: expect.arrayContaining([{ role: 'user', content: 'Only the selected sentence.' }]) });
  });

  it('ends safely when configuration storage cannot be read', async () => {
    const { manager, storage, provider, fetchImpl } = setup();
    storage.get.mockRejectedValueOnce(new Error('private storage failure'));
    const port = new FakePort();
    createTranslationSession(port, { detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }), getRequestConfiguration: () => manager.requestConfiguration(), streamTranslation: (input) => provider.stream(input) });
    port.onMessage.emit({ type: 'translate', requestId: 'failed-read', text: 'Selected text.' });
    await vi.waitFor(() => expect(port.messages).toContainEqual(expect.objectContaining({ type: 'error', requestId: 'failed-read', code: 'invalid_configuration', partial: false, showSettings: true })));
    expect(JSON.stringify(port.messages)).not.toContain('private storage failure');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects arbitrary model IDs, changed credentials, spoofed callers, and restart-invalid tokens', async () => {
    const { handle, makeHandler, makeManager, fetchImpl } = setup();
    const catalog = success(await handle({ type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' }, sender));
    const save = { type: 'save-settings', providerId: 'deepseek', apiKey: 'fake-key', modelId: 'future-text-model', catalogToken: catalog.catalogToken };
    for (const message of [{ ...save, modelId: 'manual-model' }]) {
      expect(await handle(message, sender)).toMatchObject({ ok: false, code: 'invalid_configuration' });
    }
    expect(await makeHandler(makeManager())(save, sender)).toMatchObject({ ok: false, code: 'catalog_expired' });
    for (const message of [{ ...save, apiKey: 'other-key' }, { ...save, providerId: 'openai' }]) {
      expect(await handle(message, sender)).toMatchObject({ ok: false, code: 'catalog_expired' });
    }
    expect(await handle(save, { ...sender, url: 'https://example.com' })).toBeUndefined();
    expect(await handle({ ...save, baseUrl: 'https://evil.test' }, sender)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});


it('uses the complete saved catalog despite a token from before worker restart', async () => {
  const { handle, makeHandler, makeManager, fetchImpl } = setup();
  const catalog = success(await handle({ type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' }, sender));
  const message = { type: 'save-settings', providerId: 'deepseek', apiKey: 'fake-key', modelId: 'future-text-model', catalogToken: catalog.catalogToken };
  success(await handle(message, sender));
  const restarted = makeHandler(makeManager());
  success(await restarted(message, sender));
  success(await restarted({ ...message, type: 'test-connection' }, sender));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
