import { describe, expect, it, vi } from 'vitest';
import { KimiProvider } from '../../src/background/kimi-provider';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';

function response(events: unknown[], done = true): Response {
  const bytes = new TextEncoder().encode(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''));
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
}

function start(provider: KimiProvider): FakePort {
  const port = new FakePort();
  createTranslationSession(port, {
    detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }),
    getApiKey: async () => 'private-key',
    streamTranslation: (input) => provider.stream({ ...input, modelId: 'future-kimi' }),
  });
  port.onMessage.emit({ type: 'translate', requestId: 'kimi', text: 'Complete selection' });
  return port;
}

describe('Kimi official China adapter', () => {
  it('sends only selected data and streams text with model defaults', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([
      { choices: [{ delta: { reasoning_content: 'hidden' }, finish_reason: null }] },
      { choices: [{ delta: { content: '译文' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    const port = start(new KimiProvider(fetchImpl));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('complete'));
    expect(port.messages.filter((m) => m.type === 'chunk')).toEqual([{ type: 'chunk', requestId: 'kimi', text: '译文' }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.moonshot.cn/v1/chat/completions');
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer private-key' } });
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'future-kimi', messages: [{ role: 'system', content: expect.any(String) }, { role: 'user', content: 'Complete selection' }], stream: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['length', 'tool_calls', 'content_filter'])('preserves partial translation on %s without success', async (reason) => {
    const port = start(new KimiProvider(async () => response([
      { choices: [{ delta: { content: '部分' }, finish_reason: reason }] },
    ])));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code: 'invalid_stream', partial: true });
  });

  it('rejects DONE without a valid finish reason', async () => {
    const port = start(new KimiProvider(async () => response([{ choices: [{ delta: { content: '部分' } }] }])));
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code: 'invalid_stream', partial: true });
  });

  it('keeps multimodal and unknown catalog IDs, with no guessed whitelist', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ object: 'list', data: [{ id: 'future', supports_image_in: true }, { id: 'unknown' }] }));
    const models = await new KimiProvider(fetchImpl).listModels({ apiKey: 'private-key', signal: new AbortController().signal });
    expect(models).toEqual([{ id: 'future' }, { id: 'unknown' }]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.moonshot.cn/v1/models');
  });

  it('does not call a partial catalog complete', async () => {
    const provider = new KimiProvider(async () => Response.json({ object: 'list', data: [], has_more: true }));
    await expect(provider.listModels({ apiKey: 'private-key', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid_models' });
  });

  it('cancels stream reads when the card cancels', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const port = start(new KimiProvider(fetchImpl));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    port.onMessage.emit({ type: 'cancel', requestId: 'kimi' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(port.messages.at(-1)?.type).toBe('cancelled');
  });
});
