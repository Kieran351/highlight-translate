import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderFailure } from '../../src/background/provider';
import type { TranslationDependencies } from '../../src/background/translation-session';
import { connectExtensionPort, createTranslationClient } from '../../src/content/translation-client';
import type { ClientPort, TranslationClient } from '../../src/content/translation-client';
import { PORT_NAME } from '../../src/shared/constants';
import { UI_TEXT } from '../../src/shared/ui-text';
import { createSessionBridge } from '../helpers/session-bridge';

function clientHarness(overrides: Partial<TranslationDependencies> = {}) {
  const bridge = createSessionBridge(overrides);
  let nextRequestId = 0;
  const client = createTranslationClient({
    connect: bridge.connect,
    createRequestId: () => `request-${++nextRequestId}`,
  });
  return { bridge, client };
}

async function waitForView(
  client: TranslationClient,
  predicate: (view: ReturnType<TranslationClient['view']>) => boolean,
): Promise<void> {
  await vi.waitFor(() => expect(predicate(client.view())).toBe(true));
}

describe('TranslationClient', () => {
  it('streams chunks, completes, and exposes copy and activity state', async () => {
    const { bridge, client } = clientHarness({
      streamTranslation: async ({ onChunk }) => {
        onChunk('你');
        onChunk('好');
      },
    });
    const observedTexts: string[] = [];
    const observedViews: string[] = [];
    client.subscribe((view) => {
      observedTexts.push(view.text);
      observedViews.push(`${view.status}:${view.activity}`);
    });

    client.translate('Complete selection');
    expect(observedViews).toContain('streaming:active');
    await waitForView(client, (view) => view.status === 'complete');

    expect(client.view()).toMatchObject({
      text: '你好',
      status: 'complete',
      canCopy: true,
      activity: 'stopped',
    });
    expect(observedTexts).toContain('你');
    expect(observedTexts).toContain('你好');
    expect(bridge.connections).toHaveLength(1);
    expect(bridge.connections[0]?.clientMessages).toEqual([
      { type: 'translate', requestId: 'request-1', text: 'Complete selection' },
    ]);
    expect(bridge.connections[0]?.fakePort.messages.map((message) => message.type)).toEqual([
      'route',
      'chunk',
      'chunk',
      'complete',
    ]);
    client.retry();
    expect(bridge.connections[0]?.clientMessages).toHaveLength(1);
    client.cancel();
    expect(bridge.connections[0]?.clientMessages).toHaveLength(1);
    expect(client.view()).toMatchObject({ status: 'idle', activity: 'stopped' });
    client.dispose();
  });

  it('ignores late messages from the previous request after a new translation starts', async () => {
    const calls: Array<{ onChunk(text: string): void; resolve(): void }> = [];
    const streamTranslation: TranslationDependencies['streamTranslation'] = ({ onChunk, signal }) => new Promise<void>((resolve, reject) => {
      calls.push({ onChunk, resolve });
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const { bridge, client } = clientHarness({ streamTranslation });

    client.translate('Old selection');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    client.translate('New selection');
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    const connection = bridge.connections[0]!;
    connection.sendRawToClient(null);
    connection.sendRawToClient({ type: 'unknown', requestId: 'request-2' });
    connection.sendRawToClient({ type: 'complete' });
    connection.sendToClient({ type: 'chunk', requestId: 'request-1', text: '迟到片段' });
    connection.sendToClient({ type: 'complete', requestId: 'request-1' });
    await Promise.resolve();
    expect(client.view()).toMatchObject({ text: '', status: 'streaming' });
    calls[0]?.onChunk('旧请求片段');
    calls[1]?.onChunk('当前译文');
    calls[1]?.resolve();
    await waitForView(client, (view) => view.status === 'complete');

    expect(client.view()).toMatchObject({ text: '当前译文', status: 'complete' });
    expect(connection.clientMessages).toEqual([
      { type: 'translate', requestId: 'request-1', text: 'Old selection' },
      { type: 'cancel', requestId: 'request-1' },
      { type: 'translate', requestId: 'request-2', text: 'New selection' },
    ]);
    client.dispose();
  });

  it('cancels only an active request and ignores its late messages', async () => {
    const calls: Array<{ signal: AbortSignal }> = [];
    const streamTranslation: TranslationDependencies['streamTranslation'] = ({ signal }) => new Promise<void>((_resolve, reject) => {
      calls.push({ signal });
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const { bridge, client } = clientHarness({ streamTranslation });

    client.cancel();
    expect(bridge.connections).toHaveLength(0);
    client.translate('Selected text');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const connection = bridge.connections[0]!;
    client.cancel();
    await vi.waitFor(() => expect(connection.fakePort.messages.at(-1)?.type).toBe('cancelled'));

    expect(client.view()).toMatchObject({ text: '', status: 'idle', activity: 'stopped' });
    expect(connection.clientMessages).toEqual([
      { type: 'translate', requestId: 'request-1', text: 'Selected text' },
      { type: 'cancel', requestId: 'request-1' },
    ]);
    connection.sendToClient({ type: 'chunk', requestId: 'request-1', text: '迟到片段' });
    connection.sendToClient({ type: 'complete', requestId: 'request-1' });
    await Promise.resolve();
    expect(client.view()).toMatchObject({ text: '', status: 'idle', activity: 'stopped' });
    client.dispose();
  });

  it('keeps retry text until a new chunk replaces it and remains partial if retry fails first', async () => {
    let attempt = 0;
    let releaseNewChunk: (() => void) | undefined;
    const streamTranslation: TranslationDependencies['streamTranslation'] = async ({ onChunk }) => {
      attempt += 1;
      if (attempt === 1) {
        onChunk('旧译文');
        throw new ProviderFailure('network');
      }
      if (attempt === 2) {
        throw new ProviderFailure('network');
      }
      await new Promise<void>((resolve) => {
        releaseNewChunk = () => {
          onChunk('新译文');
          resolve();
        };
      });
    };
    const { bridge, client } = clientHarness({ streamTranslation });

    client.translate('Selected text');
    await waitForView(client, (view) => view.status === 'partial');
    expect(client.view()).toMatchObject({ text: '旧译文', retryable: true, canCopy: true });

    client.retry();
    await vi.waitFor(() => expect(attempt).toBe(2));
    await waitForView(client, (view) => view.status === 'partial');
    expect(client.view()).toMatchObject({ text: '旧译文', retryable: true });

    client.retry();
    await vi.waitFor(() => expect(releaseNewChunk).toBeTypeOf('function'));
    expect(client.view()).toMatchObject({ text: '旧译文', status: 'streaming', activity: 'active' });
    releaseNewChunk?.();
    await waitForView(client, (view) => view.status === 'complete');
    expect(client.view()).toMatchObject({ text: '新译文', canCopy: true, activity: 'stopped' });
    expect(bridge.connections).toHaveLength(1);
    expect(bridge.connections[0]?.clientMessages.filter((message) => message.type === 'translate')).toHaveLength(3);
    client.retry();
    expect(attempt).toBe(3);
    client.dispose();
  });

  it.each([
    { label: 'after partial text', firstChunk: '已有译文', expectedStatus: 'partial' },
    { label: 'before any text', firstChunk: '', expectedStatus: 'error' },
  ])('turns disconnects into retryable network errors $label and reconnects on retry', async ({ firstChunk, expectedStatus }) => {
    let attempt = 0;
    const streamTranslation: TranslationDependencies['streamTranslation'] = async ({ onChunk, signal }) => {
      attempt += 1;
      if (attempt === 1) {
        if (firstChunk) {
          onChunk(firstChunk);
        }
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
        return;
      }
      onChunk('重连后译文');
    };
    const { bridge, client } = clientHarness({ streamTranslation });

    client.translate('Selected text');
    await vi.waitFor(() => expect(attempt).toBe(1));
    if (firstChunk) {
      await waitForView(client, (view) => view.text === firstChunk);
    }
    bridge.connections[0]?.disconnect();
    await waitForView(client, (view) => view.status === expectedStatus);
    expect(client.view()).toMatchObject({
      text: firstChunk,
      errorMessage: expect.any(String),
      retryable: true,
      activity: 'stopped',
    });

    client.retry();
    await waitForView(client, (view) => view.status === 'complete');
    expect(client.view()).toMatchObject({ text: '重连后译文', canCopy: true, activity: 'stopped' });
    expect(bridge.connections).toHaveLength(2);
    expect(bridge.connections[1]?.clientMessages).toContainEqual({
      type: 'translate',
      requestId: 'request-2',
      text: 'Selected text',
    });
    client.dispose();
  });

  it.each([
    ['connect returns null', () => null],
    ['connect throws', () => { throw new Error('connect unavailable'); }],
  ])('reports an extension context error when %s', (_scenario, connect) => {
    const client = createTranslationClient({ connect, createRequestId: () => 'request-1' });

    expect(() => client.translate('Selected text')).not.toThrow();
    expect(client.view()).toMatchObject({
      status: 'error',
      errorMessage: UI_TEXT.extensionContextInvalid,
      retryable: false,
      activity: 'stopped',
    });
    client.dispose();
  });

  it('reports an extension context error when sending throws', () => {
    const port: ClientPort = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: () => { throw new Error('port disconnected'); },
    };
    const client = createTranslationClient({ connect: () => port, createRequestId: () => 'request-1' });

    client.translate('Selected text');
    expect(client.view()).toMatchObject({
      status: 'error',
      errorMessage: UI_TEXT.extensionContextInvalid,
      retryable: false,
      activity: 'stopped',
    });
    client.dispose();
  });

  it('clears the port after a send failure and reconnects for the next translation', async () => {
    let connectCount = 0;
    let requestCount = 0;
    const brokenPort: ClientPort = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: () => { throw new Error('port disconnected'); },
    };
    const bridge = createSessionBridge();
    const client = createTranslationClient({
      connect: () => {
        connectCount += 1;
        return connectCount === 1 ? brokenPort : bridge.connect();
      },
      createRequestId: () => `request-${++requestCount}`,
    });

    client.translate('First selection');
    expect(client.view()).toMatchObject({ status: 'error', retryable: false });
    client.translate('Second selection');
    await waitForView(client, (view) => view.status === 'complete');

    expect(connectCount).toBe(2);
    expect(bridge.connections).toHaveLength(1);
    expect(bridge.connections[0]?.clientMessages).toContainEqual({
      type: 'translate',
      requestId: 'request-2',
      text: 'Second selection',
    });
    client.dispose();
  });

  it('returns a local too-long result without connecting', () => {
    const connect = vi.fn(() => null);
    const client = createTranslationClient({ connect, createRequestId: () => 'request-1' });

    client.translate('字'.repeat(5_001));

    expect(client.view()).toMatchObject({
      direction: UI_TEXT.unableToTranslate,
      text: '',
      status: 'error',
      errorMessage: expect.any(String),
      retryable: false,
      showSettings: false,
      canCopy: false,
      activity: 'stopped',
    });
    expect(connect).not.toHaveBeenCalled();
    client.dispose();
  });

  it('does not notify subscribers after dispose', async () => {
    const { bridge, client } = clientHarness();
    const listener = vi.fn();
    client.subscribe(listener);
    client.translate('Selected text');
    await waitForView(client, (view) => view.status === 'complete');
    const notificationCount = listener.mock.calls.length;
    client.dispose();

    client.translate('Later selection');
    bridge.connections[0]?.sendToClient({ type: 'chunk', requestId: 'request-1', text: '迟到片段' });
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(notificationCount);
  });
});

describe('connectExtensionPort', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when the runtime namespace or connect method is missing', () => {
    vi.stubGlobal('chrome', undefined);
    expect(connectExtensionPort()).toBeNull();

    vi.stubGlobal('chrome', {});
    expect(connectExtensionPort()).toBeNull();

    vi.stubGlobal('chrome', { runtime: {} });
    expect(connectExtensionPort()).toBeNull();
  });

  it('connects with the extension port name', () => {
    const port: ClientPort = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };
    const connect = vi.fn(() => port);
    vi.stubGlobal('chrome', { runtime: { connect } });

    expect(connectExtensionPort()).toBe(port);
    expect(connect).toHaveBeenCalledWith({ name: PORT_NAME });
  });
});
