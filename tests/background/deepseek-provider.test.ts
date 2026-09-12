import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createTranslationSession } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';

function streamFrom(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(content));
      controller.close();
    },
  });
}

function workerScopedFetch(response: () => Response): typeof fetch {
  return vi.fn(function (this: unknown) {
    if (this !== globalThis) {
      throw new TypeError('Failed to execute \'fetch\' on \'WorkerGlobalScope\': Illegal invocation');
    }
    return Promise.resolve(response());
  }) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeekProvider default fetch', () => {
  it('keeps the WorkerGlobalScope receiver when testing a connection', async () => {
    const fetchImpl = workerScopedFetch(() => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchImpl);

    const provider = new DeepSeekProvider();

    await expect(provider.testConnection('private-key')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps the WorkerGlobalScope receiver when streaming a translation', async () => {
    const fetchImpl = workerScopedFetch(() => new Response(streamFrom([
      'data: {"choices":[{"delta":{"content":"译文"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))));
    vi.stubGlobal('fetch', fetchImpl);
    const onChunk = vi.fn();

    const provider = new DeepSeekProvider();
    await provider.stream({
      apiKey: 'private-key',
      text: 'Hello',
      signal: new AbortController().signal,
      onChunk,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledWith('译文');
  });
});

describe('DeepSeek request and termination boundaries', () => {
  it('disallows redirects for catalog, translation and connection testing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'dynamic-model' }] }))
      .mockResolvedValueOnce(new Response(streamFrom('data: {"choices":[{"delta":{"content":"译文"}}]}\n\ndata: [DONE]\n\n')))
      .mockResolvedValueOnce(new Response('{}'));
    const provider = new DeepSeekProvider(fetchImpl);
    await provider.listModels({ apiKey: 'private-key', signal: new AbortController().signal });
    await provider.stream({ apiKey: 'private-key', modelId: 'dynamic-model', text: 'Hello', signal: new AbortController().signal, onChunk: () => undefined });
    await provider.testConnection('private-key', 'dynamic-model');
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({ model: 'dynamic-model' });
  });

  it.each(['length', 'tool_calls', 'content_filter', 'insufficient_system_resource', 'aborted'])('preserves partial text and rejects explicit %s even before DONE', async (reason) => {
    const provider = new DeepSeekProvider(async () => new Response(streamFrom(`data: ${JSON.stringify({ choices: [{ delta: { content: '部分' }, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`)));
    const port = new FakePort();
    createTranslationSession(port, {
      detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }), getApiKey: async () => 'private-key',
      streamTranslation: (input) => provider.stream(input),
    });
    port.onMessage.emit({ type: 'translate', requestId: 'deepseek', text: 'Hello' });
    await vi.waitFor(() => expect(port.messages.at(-1)?.type).toBe('error'));
    expect(port.messages.at(-1)).toMatchObject({ code: 'invalid_stream', partial: true });
  });

  it('cancels its reader from the translation port', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const provider = new DeepSeekProvider(fetchImpl);
    const port = new FakePort();
    createTranslationSession(port, {
      detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }), getApiKey: async () => 'private-key',
      streamTranslation: (input) => provider.stream(input),
    });
    port.onMessage.emit({ type: 'translate', requestId: 'deepseek', text: 'Hello' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    port.onMessage.emit({ type: 'cancel', requestId: 'deepseek' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(port.messages.at(-1)?.type).toBe('cancelled');
  });
});
