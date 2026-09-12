import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/background/anthropic-provider';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(text);
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
}

const output = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '译文' } },
  { type: 'content_block_stop', index: 0 },
];

function start(provider: AnthropicProvider): FakePort {
  const port = new FakePort();
  createTranslationSession(port, {
    detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }),
    getApiKey: async () => 'private-key',
    streamTranslation: (input) => provider.stream({ ...input, modelId: 'future-claude' }),
  });
  port.onMessage.emit({ type: 'translate', requestId: 'anthropic', text: 'Complete selection' });
  return port;
}

describe('Anthropic official adapter', () => {
  it('sends required official headers and completes only the text stream', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse([
      { type: 'ping' }, ...output,
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ]));
    const port = start(new AnthropicProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('complete'));
    expect(port.messages.filter((m) => m.type === 'chunk')).toEqual([{ type: 'chunk', requestId: 'anthropic', text: '译文' }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init).toMatchObject({ redirect: 'error', headers: { 'x-api-key': 'private-key', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'future-claude', max_tokens: 4096, system: expect.any(String), messages: [{ role: 'user', content: 'Complete selection' }], stream: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('handles an error after HTTP200 as a safe partial failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse([...output, { type: 'error', error: { type: 'overloaded_error', message: 'private-key' } }]));
    const port = start(new AnthropicProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code: 'server', partial: true });
    expect(JSON.stringify(port.messages)).not.toContain('private-key');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['max_tokens', 'tool_use', 'refusal'])('does not present %s as a complete translation', async (reason) => {
    const port = start(new AnthropicProvider(async () => sse([...output, { type: 'message_delta', delta: { stop_reason: reason } }, { type: 'message_stop' }])));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code: 'invalid_stream', partial: true });
  });

  it('collects every authenticated catalog page and rejects a repeated cursor', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude/a', display_name: 'A' }], has_more: true, last_id: 'claude/a' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude/b', capabilities: { image_input: { supported: true } } }], has_more: false, last_id: 'claude/b' }));
    const provider = new AnthropicProvider(fetchImpl);
    const input = { apiKey: 'private-key', signal: new AbortController().signal };
    expect(await provider.listModels(input)).toEqual([{ id: 'claude/a', name: 'A' }, { id: 'claude/b' }]);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.anthropic.com/v1/models?after_id=claude%2Fa');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ headers: { 'x-api-key': 'private-key', 'anthropic-version': '2023-06-01' }, redirect: 'error' });
    fetchImpl.mockImplementation(async () => Response.json({ data: [{ id: 'loop' }], has_more: true, last_id: 'loop' }));
    await expect(provider.listModels(input)).rejects.toMatchObject({ code: 'invalid_models' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('a later page failure preserves a saved selection at the trusted settings boundary', async () => {
    const values: Record<string, unknown> = {};
    const storage = {
      get: async () => structuredClone(values),
      set: async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); },
      remove: async (key: string) => { delete values[key]; },
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'saved-model' }], has_more: false }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'other-model' }], has_more: true, last_id: 'other-model' }))
      .mockResolvedValueOnce(Response.json({ error: { type: 'rate_limit_error', message: 'secret' } }, { status: 429 }));
    const provider = new AnthropicProvider(fetchImpl);
    const manager = new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider: () => provider });
    const handle = createSettingsMessageHandler({ extensionId: 'extension-id', extensionUrl: 'chrome-extension://extension-id/', manager });
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
    const catalog = await handle({ type: 'refresh-models', providerId: 'anthropic', apiKey: 'private-key' }, sender);
    if (!catalog?.ok) throw new Error('Expected models');
    await handle({ type: 'save-settings', providerId: 'anthropic', apiKey: 'private-key', modelId: 'saved-model', catalogToken: catalog.catalogToken }, sender);
    expect(await handle({ type: 'refresh-models', providerId: 'anthropic', apiKey: 'private-key' }, sender)).toMatchObject({ ok: false, code: 'rate_limit' });
    expect((await manager.read()).configurations.anthropic).toMatchObject({ selectedModelId: 'saved-model', models: [{ id: 'saved-model' }], selectionMissing: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
