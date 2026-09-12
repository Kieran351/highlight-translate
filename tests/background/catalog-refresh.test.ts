import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';
import type { SettingsResponse } from '../../src/shared/messages';

const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
const refreshMessage = { type: 'refresh-models', providerId: 'deepseek', apiKey: 'fake-key' };
const saveMessage = { type: 'save-settings', providerId: 'deepseek', apiKey: 'fake-key', modelId: 'old-model' };
function success(response: SettingsResponse | undefined) {
  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected success');
  return response;
}
async function setup() {
  const values: Record<string, unknown> = {};
  const storage = {
    get: async () => structuredClone(values),
    set: async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); },
    remove: async (key: string) => { delete values[key]; },
  };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [{ id: 'old-model' }] }));
  const provider = new DeepSeekProvider(fetchImpl);
  const makeManager = () => new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider: () => provider });
  const manager = makeManager();
  const handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', manager });
  const catalog = success(await handle(refreshMessage, sender));
  success(await handle({ ...saveMessage, catalogToken: catalog.catalogToken }, sender));
  return { handle, manager, makeManager, fetchImpl, provider, originalToken: catalog.catalogToken };
}
afterEach(() => vi.useRealTimers());

describe('safe complete catalog refresh', () => {
  it.each([401, 429, 500])('keeps saved models and choice after HTTP %s and allows retry', async (status) => {
    const { handle, makeManager, fetchImpl } = await setup();
    fetchImpl.mockResolvedValueOnce(new Response('private server detail', { status }));
    const response = await handle(refreshMessage, sender);
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toContain('private server detail');
    expect((await makeManager().read()).configurations.deepseek).toMatchObject({ selectedModelId: 'old-model', models: [{ id: 'old-model' }], selectionMissing: false });
    success(await handle(refreshMessage, sender));
  });

  it('retains the missing selection, blocks new remote translations, and recovers by explicit choice', async () => {
    const { handle, manager, makeManager, fetchImpl, provider, originalToken } = await setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: 'new-model' }] }));
    const refreshed = success(await handle(refreshMessage, sender));
    expect(refreshed.settings?.configurations.deepseek).toMatchObject({ selectedModelId: 'old-model', selectionMissing: true, models: [{ id: 'new-model' }] });
    expect((await makeManager().read()).activeProviderId).toBe('deepseek');
    expect(await manager.requestConfiguration()).toBeNull();
    expect(await handle({ ...saveMessage, catalogToken: originalToken }, sender)).toMatchObject({ ok: false, code: 'invalid_configuration' });
    const port = new FakePort();
    createTranslationSession(port, { detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }), getRequestConfiguration: () => manager.requestConfiguration(), streamTranslation: (input) => provider.stream(input) });
    port.onMessage.emit({ type: 'translate', requestId: 'missing-model', text: 'Selected sentence.' });
    await vi.waitFor(() => expect(port.messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'invalid_configuration', showSettings: true })));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    success(await handle({ ...saveMessage, modelId: 'new-model', catalogToken: refreshed.catalogToken }, sender));
    expect(await manager.requestConfiguration()).toMatchObject({ modelId: 'new-model' });
  });

  it('lets an already streaming request finish after its model disappears', async () => {
    const { handle, manager, provider, fetchImpl } = await setup();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
    const port = new FakePort();
    createTranslationSession(port, { detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }), getRequestConfiguration: () => manager.requestConfiguration(), streamTranslation: (input) => provider.stream(input) });
    port.onMessage.emit({ type: 'translate', requestId: 'running', text: 'Selected sentence.' });
    stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n'));
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'chunk', requestId: 'running', text: '第一段' }));
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [] }));
    success(await handle(refreshMessage, sender));
    expect(await manager.requestConfiguration()).toBeNull();
    stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"末段"}}]}\n\ndata: [DONE]\n\n'));
    stream.close();
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'complete', requestId: 'running' }));
    expect(port.messages).toContainEqual({ type: 'chunk', requestId: 'running', text: '末段' });
  });

  it('does not publish malformed data and distinguishes a successful empty catalog', async () => {
    const { handle, manager, fetchImpl } = await setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: 'new-model' }, {}] }));
    expect(await handle(refreshMessage, sender)).toMatchObject({ ok: false, code: 'invalid_models' });
    expect(await manager.requestConfiguration()).toMatchObject({ modelId: 'old-model' });
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [] }));
    const response = success(await handle(refreshMessage, sender));
    expect(response.catalogSummary).toEqual({ receivedCount: 0, selectableCount: 0 });
    expect(response.settings?.configurations.deepseek).toMatchObject({ selectedModelId: 'old-model', selectionMissing: true, models: [] });
  });

  it('keeps draft key results from changing the active saved configuration', async () => {
    const { handle, manager, fetchImpl } = await setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: 'draft-model' }] }));
    success(await handle({ ...refreshMessage, apiKey: 'new-draft-key' }, sender));
    expect(await manager.requestConfiguration()).toEqual({ providerId: 'deepseek', apiKey: 'fake-key', modelId: 'old-model' });
  });

  it('aborts and reports a list timeout while preserving the previous catalog', async () => {
    const { handle, manager, fetchImpl } = await setup();
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchImpl.mockImplementationOnce(async (_url, request) => {
      signal = request?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const pending = handle(refreshMessage, sender);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ ok: false, code: 'timeout_models' });
    expect(signal?.aborted).toBe(true);
    expect(await manager.requestConfiguration()).toMatchObject({ modelId: 'old-model' });
  });
});


it('never revives a removed model using an older manager draft over the current persisted catalog', async () => {
  const { handle, makeManager, fetchImpl, originalToken } = await setup();
  fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: 'new-model' }] }));
  await makeManager().refresh('deepseek', 'fake-key');
  expect(await handle({ ...saveMessage, catalogToken: originalToken }, sender))
    .toMatchObject({ ok: false, code: 'invalid_configuration' });
  expect(await handle({ ...saveMessage, type: 'test-connection', catalogToken: originalToken }, sender))
    .toMatchObject({ ok: false, code: 'invalid_configuration' });
  expect((await makeManager().read()).configurations.deepseek?.models).toEqual([{ id: 'new-model' }]);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
