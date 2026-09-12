import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';

const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
const validStream = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';

async function setup() {
  const values: Record<string, unknown> = {};
  const storage = {
    get: async () => structuredClone(values),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); }),
    remove: async (key: string) => { delete values[key]; },
  };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ id: 'chosen-model' }] }));
  const manager = new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider: () => new DeepSeekProvider(fetchImpl) });
  const handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', manager });
  const catalog = await handle({ type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' }, sender);
  if (!catalog?.ok) throw new Error('Expected catalog');
  const configuration = { providerId: 'deepseek', apiKey: 'fake-key', modelId: 'chosen-model', catalogToken: catalog.catalogToken };
  return { handle, fetchImpl, storage, configuration };
}

afterEach(() => vi.useRealTimers());

describe('optional translation through settings messages', () => {
  it('uses a fixed English text and the proven draft model, without saving', async () => {
    const { handle, fetchImpl, storage, configuration } = await setup();
    fetchImpl.mockResolvedValueOnce(new Response(validStream));
    expect(await handle({ type: 'test-connection', ...configuration }, sender)).toEqual({ ok: true });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.deepseek.com/chat/completions');
    const request = fetchImpl.mock.calls[1]?.[1];
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
    expect(JSON.parse(request?.body as string)).toMatchObject({ model: 'chosen-model', stream: true, messages: expect.arrayContaining([{ role: 'user', content: 'Hello, world!' }]) });
    expect(storage.set).not.toHaveBeenCalled();
    expect(await handle({ type: 'get-settings' }, sender)).toMatchObject({ settings: { activeProviderId: null, configurations: {} } });
  });

  it.each([
    ['data: [DONE]\n\n', 'empty_response'],
    ['data: {"choices":[{"delta":{"content":"  "}}]}\n\ndata: [DONE]\n\n', 'empty_response'],
    ['{}', 'invalid_stream'],
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'invalid_stream'],
  ])('rejects incomplete or empty output and still allows saving (%s)', async (body, code) => {
    const { handle, fetchImpl, configuration } = await setup();
    fetchImpl.mockResolvedValueOnce(new Response(body));
    expect(await handle({ type: 'test-connection', ...configuration }, sender)).toMatchObject({ ok: false, code });
    expect(await handle({ type: 'save-settings', ...configuration }, sender)).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('times out the complete test after 20 seconds, aborts and never retries', async () => {
    vi.useFakeTimers();
    const { handle, fetchImpl, configuration } = await setup();
    fetchImpl.mockImplementationOnce(async () => new Promise<Response>(() => {}));
    const pending = handle({ type: 'test-connection', ...configuration }, sender);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ ok: false, code: 'timeout_test', message: '测试翻译超时，请重试。' });
    expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await handle({ type: 'save-settings', ...configuration }, sender)).toMatchObject({ ok: true });
  });

  it('tests a saved configuration without a draft token and safely reports authentication failure', async () => {
    const { handle, fetchImpl, storage, configuration } = await setup();
    expect(await handle({ type: 'save-settings', ...configuration }, sender)).toMatchObject({ ok: true });
    const saved = await handle({ type: 'get-settings' }, sender);
    const message = { type: 'test-connection', providerId: configuration.providerId, apiKey: configuration.apiKey, modelId: configuration.modelId };
    fetchImpl.mockResolvedValueOnce(new Response('private raw response fake-key', { status: 401 }));
    const result = await handle(message, sender);
    expect(result).toMatchObject({ ok: false, code: 'authentication' });
    expect(JSON.stringify(result)).not.toMatch(/private|fake-key/);
    expect(await handle({ type: 'get-settings' }, sender)).toEqual(saved);
    fetchImpl.mockResolvedValueOnce(new Response(validStream));
    expect(await handle(message, sender)).toEqual({ ok: true });
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects credentials or models without matching catalog proof before fetching', async () => {
    const { handle, fetchImpl, configuration } = await setup();
    for (const change of [{ apiKey: 'other-key' }, { modelId: 'manual-model' }, { providerId: 'openai' }]) {
      expect(await handle({ type: 'test-connection', ...configuration, ...change }, sender)).toMatchObject({ ok: false, code: 'invalid_configuration' });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
