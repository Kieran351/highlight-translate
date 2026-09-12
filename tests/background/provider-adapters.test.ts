import { describe, expect, it, vi } from 'vitest';
import { MiniMaxProvider } from '../../src/background/minimax-provider';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';

function sse(events: unknown[], split = false): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } }));
}

const textEvents = [
  { type: 'message_start', message: {} },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
];

function start(provider: MiniMaxProvider): FakePort {
  const port = new FakePort();
  createTranslationSession(port, {
    detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }),
    getApiKey: async () => 'private-key',
    streamTranslation: (input) => provider.stream({ ...input, modelId: 'future-model' }),
  });
  port.onMessage.emit({ type: 'translate', requestId: 'vendor', text: 'Complete selection' });
  return port;
}

describe('MiniMax through the translation port', () => {
  it('streams byte-fragmented UTF-8 and CRLF, keeps only text and uses the fixed China endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => sse(textEvents, true));
    const port = start(new MiniMaxProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('complete'));
    expect(port.messages.filter((m) => m.type === 'chunk')).toEqual([{ type: 'chunk', requestId: 'vendor', text: '你好' }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.minimax.cn/anthropic/v1/messages');
    expect(init).toMatchObject({ redirect: 'error', headers: { 'x-api-key': 'private-key' } });
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'future-model', max_tokens: 4096, system: expect.any(String), messages: [{ role: 'user', content: 'Complete selection' }], stream: true });
    expect(JSON.stringify(port.messages)).not.toContain('private');
  });

  it.each([401, 402, 429, 500])('normalizes HTTP %i with no retry or response leakage', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-key Complete selection', { status }));
    const port = start(new MiniMaxProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code: ({ 401: 'authentication', 402: 'quota', 429: 'rate_limit', 500: 'server' })[status], partial: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(port.messages)).not.toContain('private-key');
  });

  it.each([
    [textEvents.slice(0, 7), 'invalid_stream', true],
    [[...textEvents.slice(0, 7), { type: 'error', error: { type: 'overloaded_error', message: 'private-key' } }], 'server', true],
    [[...textEvents.slice(0, 7), { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }], 'invalid_stream', true],
    [[{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }], 'empty_response', false],
  ])('handles incomplete, event-error, truncated and empty streams', async (events, code, partial) => {
    const port = start(new MiniMaxProvider(async () => sse(events as unknown[])));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code, partial });
  });

  it('cancels the underlying reader when the public port cancels', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const port = start(new MiniMaxProvider(fetchImpl));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    port.onMessage.emit({ type: 'cancel', requestId: 'vendor' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(port.messages.at(-1)?.type).toBe('cancelled');
    expect(port.messages.some((m) => m.type === 'error')).toBe(false);
  });
});

describe('MiniMax model catalog', () => {
  it('collects all pages with API IDs and unknown capabilities preserved', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'new/model', display_name: '<script>name</script>' }], has_more: true, last_id: 'new/model' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'unverified-future-model' }], has_more: false, last_id: 'unverified-future-model' }));
    const provider = new MiniMaxProvider(fetchImpl);
    const result = await provider.listModels({ apiKey: 'private-key', signal: new AbortController().signal });
    expect(result).toEqual([{ id: 'new/model', name: '<script>name</script>' }, { id: 'unverified-future-model' }]);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.minimax.cn/anthropic/v1/models?after_id=new%2Fmodel');
  });

  it.each([
    { data: [{ id: 'valid' }], has_more: true },
    { data: [{ id: 1 }], has_more: false },
    { has_more: false },
  ])('rejects incomplete or invalid catalogs instead of returning an empty list', async (page) => {
    const provider = new MiniMaxProvider(async () => Response.json(page));
    await expect(provider.listModels({ apiKey: 'private-key', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid_models' });
  });

  it('accepts a valid empty list', async () => {
    const provider = new MiniMaxProvider(async () => Response.json({ data: [], has_more: false }));
    await expect(provider.listModels({ apiKey: 'private-key', signal: new AbortController().signal })).resolves.toEqual([]);
  });
});
