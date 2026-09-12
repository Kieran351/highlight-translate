import { describe, expect, it, vi } from 'vitest';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { createProviderRegistry } from '../../src/background/provider-registry';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';
import type { ProviderId } from '../../src/shared/types';
import type { SettingsResponse } from '../../src/shared/messages';

const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function success(response: SettingsResponse | undefined) {
  if (!response?.ok) throw new Error(`Expected success: ${JSON.stringify(response)}`);
  return response;
}
function setup() {
  const values: Record<string, unknown> = {};
  const storage = {
    get: vi.fn(async () => structuredClone(values)),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ object: 'list', data: [{ id: 'model-a' }] }));
  const resolveProvider = createProviderRegistry(fetchImpl);
  const manager = new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider });
  const handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', manager });
  const refresh = (apiKey = 'key-a', providerId: ProviderId = 'deepseek') => handle({ type: 'refresh-models', providerId, apiKey }, sender);
  const save = (catalogToken?: string, apiKey = 'key-a', modelId = 'model-a', providerId: ProviderId = 'deepseek') => handle({ type: 'save-settings', providerId, apiKey, modelId, ...(catalogToken ? { catalogToken } : {}) }, sender);
  return { handle, manager, refresh, save, fetchImpl, storage, resolveProvider };
}

describe('configuration ordering through public messages', () => {
  it('never publishes a slow earlier refresh or an earlier credential result', async () => {
    const { refresh, save, fetchImpl, manager } = setup();
    const old = deferred<Response>();
    fetchImpl.mockReturnValueOnce(old.promise);
    const oldRefresh = refresh();
    const latest = success(await refresh('key-b'));
    success(await save(latest.catalogToken, 'key-b'));
    old.resolve(Response.json({ object: 'list', data: [{ id: 'stale-model' }] }));
    expect(await oldRefresh).toMatchObject({ ok: false });
    expect(await manager.requestConfiguration()).toEqual({ providerId: 'deepseek', apiKey: 'key-b', modelId: 'model-a' });
  });

  it('cannot use old proofs or complete a pending refresh after clearing a supplier', async () => {
    const { refresh, save, handle, fetchImpl, manager } = setup();
    const initial = success(await refresh());
    success(await save(initial.catalogToken));
    const pending = deferred<Response>();
    fetchImpl.mockReturnValueOnce(pending.promise);
    const refreshing = refresh();
    success(await handle({ type: 'clear-settings', providerId: 'deepseek' }, sender));
    expect(await save(initial.catalogToken)).toMatchObject({ ok: false });
    pending.resolve(Response.json({ object: 'list', data: [{ id: 'model-a' }] }));
    expect(await refreshing).toMatchObject({ ok: false });
    expect((await manager.read()).configurations).toEqual({});
  });

  it('checks proof against the newest complete catalog when a save waits behind its storage commit', async () => {
    const { refresh, save, storage, fetchImpl, manager } = setup();
    const initial = success(await refresh());
    success(await save(initial.catalogToken));
    const originalSet = storage.set.getMockImplementation()!;
    const persisted = deferred<void>();
    storage.set.mockImplementationOnce(async (items) => { await persisted.promise; await originalSet(items); });
    fetchImpl.mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'model-b' }] }));
    const updating = refresh();
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(2));
    const saving = save(initial.catalogToken);
    persisted.resolve();
    success(await updating);
    expect(await saving).toMatchObject({ ok: false, code: 'invalid_configuration' });
    expect((await manager.read()).configurations.deepseek).toMatchObject({ selectedModelId: 'model-a', models: [{ id: 'model-b' }], selectionMissing: true });
  });

  it('keeps only the latest successful credential proof for each supplier', async () => {
    const { refresh, save, fetchImpl, manager } = setup();
    const original = success(await refresh());
    success(await save(original.catalogToken));
    const delayed = deferred<Response>();
    fetchImpl.mockReturnValueOnce(delayed.promise);
    const older = refresh();
    const current = success(await refresh());
    delayed.resolve(Response.json({ object: 'list', data: [{ id: 'stale' }] }));
    expect(await older).toMatchObject({ ok: false });
    expect(await save(original.catalogToken)).toMatchObject({ ok: false });
    success(await save(current.catalogToken));
    const newKey = success(await refresh('new-key'));
    expect(await save(current.catalogToken)).toMatchObject({ ok: false });
    success(await save(newKey.catalogToken, 'new-key'));
    expect(await manager.requestConfiguration()).toMatchObject({ apiKey: 'new-key' });
  });

  it('captures the accepted request before delayed language detection and serializes the storage snapshot before a save', async () => {
    const { refresh, save, manager, fetchImpl, resolveProvider, storage } = setup();
    const first = success(await refresh());
    success(await save(first.catalogToken));
    fetchImpl.mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'model-b' }] }));
    const changed = success(await refresh('key-b'));
    const detected = deferred<{ kind: 'unknown'; label: '自动检测' }>();
    const readGate = deferred<void>();
    const originalGet = storage.get.getMockImplementation()!;
    storage.get.mockImplementationOnce(async () => { await readGate.promise; return originalGet(); });
    const port = new FakePort();
    createTranslationSession(port, { detectLanguage: () => detected.promise, getRequestConfiguration: () => manager.requestConfiguration(), streamTranslation: (input) => resolveProvider(input.providerId!).stream(input) });
    port.onMessage.emit({ type: 'translate', requestId: 'accepted', text: 'Selected before save.' });
    const saving = save(changed.catalogToken, 'key-b', 'model-b');
    await Promise.resolve();
    expect(storage.set).toHaveBeenCalledTimes(1);
    readGate.resolve();
    success(await saving);
    fetchImpl.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"旧配置"}}]}\n\ndata: [DONE]\n\n'));
    detected.resolve({ kind: 'unknown', label: '自动检测' });
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'complete', requestId: 'accepted' }));
    const [, request] = fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(request?.body as string).model).toBe('model-a');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer key-a' });
    expect(await manager.requestConfiguration()).toMatchObject({ apiKey: 'key-b', modelId: 'model-b' });
  });

  it.each(['pending', 'rejected'])('finishes Chinese locally with %s configuration storage', async (mode) => {
    const { manager, storage, fetchImpl, resolveProvider } = setup();
    const pending = deferred<Record<string, unknown>>();
    if (mode === 'pending') storage.get.mockReturnValueOnce(pending.promise);
    else storage.get.mockRejectedValueOnce(new Error('private storage error'));
    const port = new FakePort();
    createTranslationSession(port, { detectLanguage: async () => ({ kind: 'chinese', label: '中文' }), getRequestConfiguration: () => manager.requestConfiguration(), streamTranslation: (input) => resolveProvider(input.providerId!).stream(input) });
    port.onMessage.emit({ type: 'translate', requestId: 'local', text: '中文文本' });
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'complete', requestId: 'local' }));
    expect(port.messages).toContainEqual({ type: 'chunk', requestId: 'local', text: '中文文本' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(port.messages.some((message) => message.type === 'error')).toBe(false);
    pending.resolve({});
  });

  it('uses one immutable supplier/key/model for a running stream and new settings for the next request', async () => {
    const { refresh, save, manager, fetchImpl, resolveProvider } = setup();
    const dsCatalog = success(await refresh());
    success(await save(dsCatalog.catalogToken));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) { controller = stream; } })));
    const port = new FakePort();
    createTranslationSession(port, { detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }), getRequestConfiguration: () => manager.requestConfiguration(), streamTranslation: (input) => resolveProvider(input.providerId!).stream(input) });
    port.onMessage.emit({ type: 'translate', requestId: 'first', text: 'Selected first.' });
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"原配置"}}]}\n\n'));
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'chunk', requestId: 'first', text: '原配置' }));
    fetchImpl.mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'kimi-new' }] }));
    const kimiCatalog = success(await refresh('kimi-key', 'kimi'));
    success(await save(kimiCatalog.catalogToken, 'kimi-key', 'kimi-new', 'kimi'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'complete', requestId: 'first' }));
    fetchImpl.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"新配置"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    port.onMessage.emit({ type: 'translate', requestId: 'manual-retry', text: 'Selected first.' });
    await vi.waitFor(() => expect(port.messages).toContainEqual({ type: 'complete', requestId: 'manual-retry' }));
    const streams = fetchImpl.mock.calls.filter(([, request]) => request?.method === 'POST');
    expect(streams.map(([url]) => url)).toEqual(['https://api.deepseek.com/chat/completions', 'https://api.moonshot.cn/v1/chat/completions']);
    expect(streams.map(([, request]) => JSON.parse(request?.body as string).model)).toEqual(['model-a', 'kimi-new']);
    expect(streams.map(([, request]) => (request?.headers as Record<string, string>).Authorization)).toEqual(['Bearer key-a', 'Bearer kimi-key']);
    expect((await manager.read()).configurations.deepseek?.apiKey).toBe('key-a');
  });
});
