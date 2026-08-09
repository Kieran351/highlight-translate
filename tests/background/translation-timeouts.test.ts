import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslationSession } from '../../src/background/translation-session';
import type { TranslationDependencies } from '../../src/background/translation-session';
import { FakePort } from '../helpers/fake-port';

function hangingStream(onStart?: (input: Parameters<TranslationDependencies['streamTranslation']>[0]) => void) {
  return vi.fn((input: Parameters<TranslationDependencies['streamTranslation']>[0]) => {
    onStart?.(input);
    return new Promise<void>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
}

function createHarness(streamTranslation: TranslationDependencies['streamTranslation']) {
  const port = new FakePort();
  createTranslationSession(port, {
    detectLanguage: vi.fn().mockResolvedValue({ kind: 'known', code: 'en', label: '英语' }),
    getApiKey: vi.fn().mockResolvedValue('key'),
    streamTranslation,
    timeouts: { firstContentMs: 20, idleMs: 20, totalMs: 120 },
  });
  port.onMessage.emit({ type: 'translate', requestId: 'timeout', text: 'Hello' });
  return port;
}

async function errorCode(port: FakePort): Promise<string | undefined> {
  await vi.waitFor(() => expect(port.messages.some((message) => message.type === 'error')).toBe(true));
  return port.messages.find((message) => message.type === 'error')?.code;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('translation timeouts', () => {
  it('times out while waiting for the first valid content', async () => {
    vi.useFakeTimers();
    const port = createHarness(hangingStream());
    await vi.advanceTimersByTimeAsync(20);

    expect(await errorCode(port)).toBe('timeout_first');
  });

  it('resets the idle timeout after each valid chunk', async () => {
    vi.useFakeTimers();
    const port = createHarness(hangingStream(({ onChunk }) => onChunk('片段')));
    await vi.advanceTimersByTimeAsync(19);
    expect(port.messages.some((message) => message.type === 'error')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await errorCode(port)).toBe('timeout_idle');
  });

  it('enforces the total timeout even while valid chunks continue', async () => {
    vi.useFakeTimers();
    const stream = hangingStream(({ onChunk, signal }) => {
      const timer = setInterval(() => onChunk('片'), 10);
      signal.addEventListener('abort', () => clearInterval(timer));
    });
    const port = new FakePort();
    createTranslationSession(port, {
      detectLanguage: vi.fn().mockResolvedValue({ kind: 'known', code: 'en', label: '英语' }),
      getApiKey: vi.fn().mockResolvedValue('key'),
      streamTranslation: stream,
      timeouts: { firstContentMs: 20, idleMs: 20, totalMs: 35 },
    });
    port.onMessage.emit({ type: 'translate', requestId: 'total', text: 'Hello' });
    await vi.advanceTimersByTimeAsync(35);

    expect(await errorCode(port)).toBe('timeout_total');
  });
});
