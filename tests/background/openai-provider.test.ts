import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../src/background/openai-provider';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';

function sse(events: unknown[], done = ''): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + done;
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
}

function start(provider: OpenAIProvider, modelId = 'future-text-model'): FakePort {
  const port = new FakePort();
  createTranslationSession(port, {
    detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }),
    getApiKey: async () => 'private-key',
    streamTranslation: (input) => provider.stream({ ...input, modelId }),
  });
  port.onMessage.emit({ type: 'translate', requestId: 'openai', text: 'Complete selection' });
  return port;
}

describe('OpenAI official adapter', () => {
  it('uses stateless Responses for future model IDs and emits only text deltas', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse([
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'secret reasoning' },
      { type: 'response.function_call_arguments.delta', delta: 'secret tool args' },
      { type: 'response.output_text.delta', delta: '译文' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]));
    const port = start(new OpenAIProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('complete'));
    expect(port.messages.filter((m) => m.type === 'chunk')).toEqual([{ type: 'chunk', requestId: 'openai', text: '译文' }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer private-key' } });
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'future-text-model', instructions: expect.any(String), input: 'Complete selection', stream: true, store: false });
    expect(JSON.stringify(port.messages)).not.toContain('secret');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('selects the known legacy Chat protocol before sending, with no fallback', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse([
      { choices: [{ delta: { content: '译文' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ], 'data: [DONE]\n\n'));
    const port = start(new OpenAIProvider(fetchImpl), 'gpt-3.5-turbo-0125');
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('complete'));
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ store: false, messages: [{ role: 'system', content: expect.any(String) }, { role: 'user', content: 'Complete selection' }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [{ type: 'response.incomplete', response: { status: 'incomplete' } }, 'invalid_stream'],
    [{ type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'private-key' } } }, 'quota'],
    [{ type: 'error', code: 'rate_limit_error', message: 'private-key' }, 'rate_limit'],
    [{ type: 'error', code: 'rate_limit_exceeded', message: 'private-key' }, 'rate_limit'],
    [{ type: 'error', code: 'invalid_api_key', message: 'private-key' }, 'authentication'],
    [{ type: 'response.failed', response: { error: { type: 'invalid_request_error', code: 'insufficient_quota', message: 'private-key' } } }, 'quota'],
  ])('preserves partial text and does not retry failed Responses', async (event, code) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sse([{ type: 'response.output_text.delta', delta: '部分' }, event]));
    const port = start(new OpenAIProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code, partial: true });
    expect(JSON.stringify(port.messages)).not.toContain('private-key');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('never retries unsupported model responses on another endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret unsupported model', { status: 400 }));
    const port = start(new OpenAIProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('distinguishes exhausted quota from rate limits for HTTP 429 without leaking its error body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: 'invalid_request_error', code: 'insufficient_quota', message: 'private-key' } }, { status: 429 }));
    const port = start(new OpenAIProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code: 'quota', partial: false });
    expect(JSON.stringify(port.messages)).not.toContain('private-key');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('cancels the reader from the public protocol', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const port = start(new OpenAIProvider(fetchImpl));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    port.onMessage.emit({ type: 'cancel', requestId: 'openai' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(port.messages.at(-1)?.type).toBe('cancelled');
  });

  it('marks explicit non-translation families but preserves unknown and multimodal names', async () => {
    const ids = ['text-embedding-3-small', 'gpt-image-1', 'tts-1', 'whisper-1', 'dall-e-3', 'gpt-4o-audio-preview', 'future-image-and-text-model'];
    const provider = new OpenAIProvider(async () => Response.json({ object: 'list', data: ids.map((id) => ({ id })) }));
    const models = await provider.listModels({ apiKey: 'private-key', signal: new AbortController().signal });
    expect(models.slice(0, 5).every((model) => model.supportsText === false)).toBe(true);
    expect(models.slice(5)).toEqual([{ id: 'gpt-4o-audio-preview' }, { id: 'future-image-and-text-model' }]);
  });

  it('distinguishes all-filtered from empty through real trusted settings and prevents selecting filtered models', async () => {
    const values: Record<string, unknown> = {};
    const storage = {
      get: async () => structuredClone(values),
      set: async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); },
      remove: async (key: string) => { delete values[key]; },
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'text-embedding-3-small' }, { id: 'text-embedding-3-large' }] }))
      .mockResolvedValueOnce(Response.json({ object: 'list', data: [] }));
    const provider = new OpenAIProvider(fetchImpl);
    const manager = new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider: () => provider });
    const handle = createSettingsMessageHandler({ extensionId: 'extension-id', extensionUrl: 'chrome-extension://extension-id/', manager });
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
    const filtered = await handle({ type: 'refresh-models', providerId: 'openai', apiKey: 'private-key' }, sender);
    expect(filtered).toMatchObject({ ok: true, models: [], catalogSummary: { receivedCount: 2, selectableCount: 0 } });
    if (!filtered?.ok) throw new Error('Expected catalog');
    expect(await handle({ type: 'save-settings', providerId: 'openai', apiKey: 'private-key', modelId: 'text-embedding-3-small', catalogToken: filtered.catalogToken }, sender)).toMatchObject({ ok: false, code: 'invalid_configuration' });
    expect(await handle({ type: 'refresh-models', providerId: 'openai', apiKey: 'private-key' }, sender)).toMatchObject({ ok: true, models: [], catalogSummary: { receivedCount: 0, selectableCount: 0 } });
  });
});
