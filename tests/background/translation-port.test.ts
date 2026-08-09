import { describe, expect, it, vi } from 'vitest';

import {
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
  DeepSeekProvider,
} from '../../src/background/deepseek-provider';
import { createLanguageRouter } from '../../src/background/language-router';
import { ProviderFailure } from '../../src/background/provider';
import { createTranslationSession } from '../../src/background/translation-session';
import type { ServerPortMessage } from '../../src/shared/messages';
import type { LanguageRoute } from '../../src/shared/types';
import type { TranslationDependencies } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function dependencies(overrides: Partial<TranslationDependencies> = {}): TranslationDependencies {
  return {
    detectLanguage: vi.fn().mockResolvedValue({ kind: 'known', code: 'en', label: '英语' }),
    getApiKey: vi.fn().mockResolvedValue('test-key'),
    streamTranslation: vi.fn(async ({ onChunk }) => {
      onChunk('你');
      onChunk('好');
    }),
    ...overrides,
  };
}

async function waitForMessage(port: FakePort, type: ServerPortMessage['type']): Promise<void> {
  await vi.waitFor(() => {
    expect(port.messages.some((message) => message.type === type)).toBe(true);
  });
}

describe('translation port protocol', () => {
  it('returns a Chinese selection locally without reading the key or calling the provider', async () => {
    const port = new FakePort();
    const getApiKey = vi.fn();
    const streamTranslation = vi.fn();
    createTranslationSession(port, dependencies({
      detectLanguage: vi.fn().mockResolvedValue({ kind: 'chinese', label: '中文' }),
      getApiKey,
      streamTranslation,
    }));

    port.onMessage.emit({ type: 'translate', requestId: 'r1', text: '你好，世界' });
    await waitForMessage(port, 'complete');

    expect(port.messages).toEqual([
      { type: 'route', requestId: 'r1', direction: '中文', local: true },
      { type: 'chunk', requestId: 'r1', text: '你好，世界' },
      { type: 'complete', requestId: 'r1' },
    ]);
    expect(getApiKey).not.toHaveBeenCalled();
    expect(streamTranslation).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'known', code: 'en', label: '英语' } satisfies LanguageRoute, '英语 → 简体中文'],
    [{ kind: 'unknown', label: '自动检测' } satisfies LanguageRoute, '自动检测 → 简体中文'],
  ])('streams %s selections with the correct direction', async (route, direction) => {
    const port = new FakePort();
    const streamTranslation = vi.fn(async ({ text, apiKey, onChunk }) => {
      expect(text).toBe('Hello');
      expect(apiKey).toBe('test-key');
      onChunk('你');
      onChunk('好');
    });
    createTranslationSession(port, dependencies({
      detectLanguage: vi.fn().mockResolvedValue(route),
      streamTranslation,
    }));

    port.onMessage.emit({ type: 'translate', requestId: 'r2', text: 'Hello' });
    await waitForMessage(port, 'complete');

    expect(port.messages).toEqual([
      { type: 'route', requestId: 'r2', direction, local: false },
      { type: 'chunk', requestId: 'r2', text: '你' },
      { type: 'chunk', requestId: 'r2', text: '好' },
      { type: 'complete', requestId: 'r2' },
    ]);
    expect(streamTranslation).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { isReliable: true, languages: [{ language: 'zh-TW', percentage: 98 }] },
      '繁體中文 mixed content',
      '中文',
      true,
    ],
    [
      { isReliable: false, languages: [] },
      'GPT',
      '自动检测 → 简体中文',
      false,
    ],
  ])('routes a complete mixed or short selection through local detection', async (
    detection,
    text,
    direction,
    local,
  ) => {
    const port = new FakePort();
    const streamTranslation = vi.fn(async ({ onChunk }) => onChunk('译文'));
    createTranslationSession(port, dependencies({
      detectLanguage: createLanguageRouter(vi.fn().mockResolvedValue(detection)),
      streamTranslation,
    }));

    port.onMessage.emit({ type: 'translate', requestId: 'route', text });
    await waitForMessage(port, 'complete');

    expect(port.messages[0]).toEqual({ type: 'route', requestId: 'route', direction, local });
    expect(streamTranslation).toHaveBeenCalledTimes(local ? 0 : 1);
  });

  it('streams split SSE through the public protocol and sends only fixed request data', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(streamFrom([
        'data: {"choices":[{"delta":{"reasoning_content":"hidden","content":"你"}}]}\r',
        '\n\r',
        '\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DO',
        'NE]\n\n',
      ]));
    };
    const provider = new DeepSeekProvider(fetchImpl);
    const port = new FakePort();
    createTranslationSession(port, dependencies({
      getApiKey: vi.fn().mockResolvedValue('private-key'),
      streamTranslation: (input) => provider.stream(input),
    }));

    const selection = 'Complete selection https://example.com';
    port.onMessage.emit({ type: 'translate', requestId: 'sse', text: selection });
    await waitForMessage(port, 'complete');

    const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(capturedUrl).toBe(DEEPSEEK_API_URL);
    expect(capturedInit?.headers).toEqual({
      Authorization: 'Bearer private-key',
      'Content-Type': 'application/json',
    });
    expect(requestBody).toMatchObject({
      model: DEEPSEEK_MODEL,
      stream: true,
      thinking: { type: 'disabled' },
      messages: [expect.objectContaining({ role: 'system' }), { role: 'user', content: selection }],
    });
    expect(JSON.stringify(requestBody)).not.toContain('private-key');
    expect(JSON.stringify(requestBody)).not.toContain('pageUrl');
    expect(port.messages.filter((message) => message.type === 'chunk')).toEqual([
      { type: 'chunk', requestId: 'sse', text: '你' },
      { type: 'chunk', requestId: 'sse', text: '好' },
    ]);
  });

  it('treats provider EOF without done as a copyable partial protocol result', async () => {
    const provider = new DeepSeekProvider(async () => new Response(streamFrom([
      'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
    ])));
    const port = new FakePort();
    createTranslationSession(port, dependencies({
      streamTranslation: (input) => provider.stream(input),
    }));

    port.onMessage.emit({ type: 'translate', requestId: 'eof', text: 'Hello' });
    await waitForMessage(port, 'error');

    expect(port.messages.at(-1)).toMatchObject({
      type: 'error',
      requestId: 'eof',
      code: 'invalid_stream',
      partial: true,
      retryable: true,
    });
  });

  it.each([
    [401, 'authentication'],
    [402, 'quota'],
    [429, 'rate_limit'],
    [500, 'server'],
  ])('normalizes provider status %i at the public protocol', async (status, code) => {
    const provider = new DeepSeekProvider(async () => new Response('', { status }));
    const port = new FakePort();
    createTranslationSession(port, dependencies({
      streamTranslation: (input) => provider.stream(input),
    }));

    port.onMessage.emit({ type: 'translate', requestId: `status-${status}`, text: 'Sensitive selection' });
    await waitForMessage(port, 'error');

    expect(port.messages.at(-1)).toMatchObject({ type: 'error', code, partial: false });
    expect(JSON.stringify(port.messages)).not.toContain('Sensitive selection');
    expect(JSON.stringify(port.messages)).not.toContain('test-key');
  });

  it('reports missing configuration without calling the provider', async () => {
    const port = new FakePort();
    const streamTranslation = vi.fn();
    createTranslationSession(port, dependencies({
      getApiKey: vi.fn().mockResolvedValue(''),
      streamTranslation,
    }));

    port.onMessage.emit({ type: 'translate', requestId: 'r3', text: 'Hello' });
    await waitForMessage(port, 'error');

    expect(port.messages.at(-1)).toMatchObject({
      type: 'error',
      requestId: 'r3',
      code: 'missing_key',
      retryable: false,
      partial: false,
    });
    expect(streamTranslation).not.toHaveBeenCalled();
  });

  it('preserves partial output and returns a normalized provider failure', async () => {
    const port = new FakePort();
    createTranslationSession(port, dependencies({
      streamTranslation: vi.fn(async ({ onChunk }) => {
        onChunk('部分');
        throw new ProviderFailure('network');
      }),
    }));

    port.onMessage.emit({ type: 'translate', requestId: 'r4', text: 'Hello' });
    await waitForMessage(port, 'error');

    expect(port.messages.at(-1)).toMatchObject({
      type: 'error',
      requestId: 'r4',
      code: 'network',
      retryable: true,
      partial: true,
    });
    expect(JSON.stringify(port.messages)).not.toContain('Hello');
    expect(JSON.stringify(port.messages)).not.toContain('test-key');
  });

  it('cancels the active request and never turns cancellation into an error', async () => {
    const port = new FakePort();
    createTranslationSession(port, dependencies({
      streamTranslation: vi.fn(({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })),
    }));

    port.onMessage.emit({ type: 'translate', requestId: 'r5', text: 'Hello' });
    await waitForMessage(port, 'route');
    port.onMessage.emit({ type: 'cancel', requestId: 'r5' });
    await waitForMessage(port, 'cancelled');

    expect(port.messages.filter((message) => message.type === 'error')).toHaveLength(0);
  });

  it('rejects invalid and overlong protocol input before language detection', async () => {
    const port = new FakePort();
    const detectLanguage = vi.fn();
    createTranslationSession(port, dependencies({ detectLanguage }));

    port.onMessage.emit({ type: 'translate', requestId: 'r6', text: '字'.repeat(5_001) });
    await waitForMessage(port, 'error');

    expect(port.messages.at(-1)).toMatchObject({ type: 'error', code: 'too_long' });
    expect(detectLanguage).not.toHaveBeenCalled();
  });
});
