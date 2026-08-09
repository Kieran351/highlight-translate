import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeepSeekProvider } from '../../src/background/deepseek-provider';

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
