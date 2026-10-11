// @vitest-environment happy-dom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCardState } from '../../src/content/card-state';
import type { CardState } from '../../src/content/card-state';

class TestResizeObserver {
  observe(): void {}

  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver);
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
  callback(0);
  return 1;
});
vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });

const port = {
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
  postMessage: vi.fn(),
};
const connect = vi.fn(() => port);
vi.stubGlobal('chrome', {
  runtime: {
    connect,
    sendMessage: vi.fn(),
  },
});

const { mountHighlightTranslateUi } = await import('../../src/content/highlight-translate-ui');

interface TestUi {
  host: HTMLElement;
  card: HTMLElement;
  resizeHandle: HTMLElement;
  activeSelection: { text: string; range: Range; tooLong: boolean } | null;
  state: CardState;
  port: chrome.runtime.Port | null;
  close(cancel: boolean): void;
  captureSelection(eventTarget: EventTarget | null): void;
  onServerMessage(message: unknown): void;
  startRequest(retry: boolean): void;
}

const mounted = mountHighlightTranslateUi();
if (!mounted) {
  throw new Error('The test UI must mount in a top-level document');
}
const ui = mounted as unknown as TestUi;

describe('content script mount', () => {
  it('creates one translation host', () => {
    expect(document.querySelectorAll('[data-highlight-translate-root]')).toHaveLength(1);
  });
});

Object.defineProperties(ui.card, {
  offsetWidth: {
    configurable: true,
    get: () => Number.parseFloat(ui.card.style.width) || 480,
  },
  offsetHeight: {
    configurable: true,
    get: () => Number.parseFloat(ui.card.style.height) || 300,
  },
});

afterAll(() => {
  ui.host.remove();
});

beforeEach(() => {
  ui.close(false);
  ui.card.classList.remove('ht-hidden');
  ui.state = { ...createCardState(), status: 'complete' };
  ui.activeSelection = null;
  ui.port = null;
  connect.mockClear();
  port.postMessage.mockClear();
});

describe('content script request UI', () => {
  it('ignores stale completion and accepts the current retry completion', () => {
    ui.activeSelection = { text: 'Hello', range: {} as Range, tooLong: false };

    ui.startRequest(true);
    expect(ui.state.status).toBe('streaming');
    expect(connect).toHaveBeenCalledOnce();

    const currentRequestId = ui.state.requestId;
    if (!currentRequestId) {
      throw new Error('A retry must have a request id');
    }
    ui.onServerMessage({ type: 'complete', requestId: 'stale-request' });
    expect(ui.state.status).toBe('streaming');

    ui.onServerMessage({ type: 'complete', requestId: currentRequestId });
    expect(ui.state.status).toBe('complete');
  });

  it('leaves the streaming state when the extension runtime connection is unavailable', () => {
    ui.activeSelection = { text: 'Hello', range: {} as Range, tooLong: false };
    const runtime = chrome.runtime as unknown as Record<string, unknown>;
    const savedConnect = runtime.connect;
    delete runtime.connect;

    try {
      expect(() => ui.startRequest(false)).not.toThrow();
      expect(ui.state.status).toBe('error');
      expect(ui.state.errorMessage).toBe('扩展已更新，请刷新当前页面后重试。');
      expect(ui.state.retryable).toBe(false);
      expect(ui.resizeHandle.classList.contains('ht-hidden')).toBe(false);
    } finally {
      runtime.connect = savedConnect;
    }
  });

  it('leaves the streaming state when the extension runtime namespace is unavailable', () => {
    ui.activeSelection = { text: 'Hello', range: {} as Range, tooLong: false };
    const chromeGlobal = chrome as unknown as { runtime?: typeof chrome.runtime };
    const savedRuntime = chromeGlobal.runtime;
    delete chromeGlobal.runtime;

    try {
      expect(() => ui.startRequest(false)).not.toThrow();
      expect(ui.state.status).toBe('error');
      expect(ui.state.errorMessage).toBe('扩展已更新，请刷新当前页面后重试。');
      expect(ui.state.retryable).toBe(false);
      expect(ui.resizeHandle.classList.contains('ht-hidden')).toBe(false);
    } finally {
      chromeGlobal.runtime = savedRuntime;
    }
  });

  it('captures a new page selection', () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'New selection';
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    ui.captureSelection(paragraph);

    expect(ui.activeSelection?.text).toBe('New selection');

    selection?.removeAllRanges();
    paragraph.remove();
  });
});
