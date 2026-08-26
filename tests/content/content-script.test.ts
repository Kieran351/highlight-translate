// @vitest-environment happy-dom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCardState } from '../../src/content/card-state';
import type { CardState } from '../../src/content/card-state';
import type { CardSizeState } from '../../src/content/card-size';

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

const { mountHighlightTranslateUi } = await import('../../src/content/content-script');

interface TestUi {
  host: HTMLElement;
  card: HTMLElement;
  resizeHandle: HTMLElement;
  activeSelection: { text: string; range: Range; tooLong: boolean } | null;
  state: CardState;
  sizeState: CardSizeState;
  close(cancel: boolean): void;
  updateResizeFeedback(): void;
  applyUserCardSize(): void;
  captureSelection(eventTarget: EventTarget | null): void;
  onServerMessage(message: unknown): void;
  startRequest(retry: boolean): void;
}

interface PointerData {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
}

function pointerEvent(type: string, data: PointerData = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: data.pointerId ?? 1 },
    pointerType: { configurable: true, value: data.pointerType ?? 'mouse' },
    isPrimary: { configurable: true, value: data.isPrimary ?? true },
    button: { configurable: true, value: data.button ?? 0 },
    buttons: { configurable: true, value: data.buttons ?? 1 },
    clientX: { configurable: true, value: data.clientX ?? 400 },
    clientY: { configurable: true, value: data.clientY ?? 300 },
  });
  return event;
}

const mounted = mountHighlightTranslateUi();
if (!mounted) {
  throw new Error('The test UI must mount in a top-level document');
}
const ui = mounted as unknown as TestUi;

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
  ui.updateResizeFeedback();
  ui.resizeHandle.setPointerCapture = vi.fn();
  ui.resizeHandle.releasePointerCapture = vi.fn();
  connect.mockClear();
  port.postMessage.mockClear();
});

describe('content script resize interaction', () => {
  it('shows the handle only after the request stops and captures valid mouse input', () => {
    ui.state = { ...ui.state, status: 'streaming' };
    ui.updateResizeFeedback();
    expect(ui.resizeHandle.classList.contains('ht-hidden')).toBe(true);

    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown'));
    expect(ui.sizeState.resize.kind).toBe('idle');

    ui.state = { ...ui.state, status: 'complete' };
    ui.updateResizeFeedback();
    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown', {
      pointerType: 'touch',
      pointerId: 2,
    }));
    expect(ui.sizeState.resize.kind).toBe('idle');

    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3 }));
    expect(ui.sizeState.resize).toMatchObject({ kind: 'pending', pointerId: 3 });
    expect(ui.resizeHandle.setPointerCapture).toHaveBeenCalledWith(3);
  });

  it('applies a normal resize and cleans up cancellation, capture loss and blur', () => {
    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 4 }));
    ui.resizeHandle.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 4,
      clientX: 430,
      clientY: 330,
    }));
    expect(ui.sizeState).toMatchObject({
      mode: { kind: 'user', target: { width: 510, height: 330 } },
      resize: { kind: 'resizing', pointerId: 4 },
    });
    ui.applyUserCardSize();
    expect(ui.card.style.width).toBe('510px');
    expect(ui.card.style.height).toBe('330px');

    ui.resizeHandle.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 4,
      clientX: 460,
      clientY: 350,
      buttons: 0,
    }));
    expect(ui.sizeState).toEqual({
      mode: { kind: 'user', target: { width: 540, height: 350 } },
      resize: { kind: 'idle' },
    });
    expect(ui.resizeHandle.releasePointerCapture).toHaveBeenCalledWith(4);

    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 5 }));
    ui.resizeHandle.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 5,
      clientX: 420,
      clientY: 310,
    }));
    ui.resizeHandle.dispatchEvent(pointerEvent('pointercancel', { pointerId: 5 }));
    expect(ui.sizeState.resize).toEqual({ kind: 'idle' });
    expect(ui.sizeState.mode).toEqual({ kind: 'user', target: { width: 530, height: 340 } });

    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 6 }));
    ui.resizeHandle.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 6,
      clientX: 430,
      clientY: 320,
    }));
    ui.resizeHandle.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: 6 }));
    expect(ui.sizeState.resize).toEqual({ kind: 'idle' });
    expect(ui.sizeState.mode).toEqual({ kind: 'user', target: { width: 540, height: 350 } });

    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7 }));
    ui.resizeHandle.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 7,
      clientX: 440,
      clientY: 330,
    }));
    window.dispatchEvent(new Event('blur'));
    expect(ui.sizeState.resize).toEqual({ kind: 'idle' });
    expect(ui.sizeState.mode).toEqual({ kind: 'user', target: { width: 550, height: 360 } });
  });

  it('cancels the resize session when pointer capture cannot be established', () => {
    ui.resizeHandle.setPointerCapture = vi.fn(() => {
      throw new Error('capture unavailable');
    });

    ui.resizeHandle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 8 }));

    expect(ui.sizeState).toEqual({ mode: { kind: 'auto' }, resize: { kind: 'idle' } });
    expect(ui.resizeHandle.dataset.resizeState).toBe('ready');
  });

  it('keeps the user target through retry while stale terminal messages stay ignored', () => {
    ui.sizeState = {
      mode: { kind: 'user', target: { width: 560, height: 420 } },
      resize: { kind: 'idle' },
    };
    ui.activeSelection = { text: 'Hello', range: {} as Range, tooLong: false };
    ui.applyUserCardSize();

    ui.startRequest(true);
    expect(ui.state.status).toBe('streaming');
    expect(ui.resizeHandle.classList.contains('ht-hidden')).toBe(true);
    expect(ui.sizeState.mode).toEqual({ kind: 'user', target: { width: 560, height: 420 } });
    expect(connect).toHaveBeenCalledOnce();

    const currentRequestId = ui.state.requestId;
    if (!currentRequestId) {
      throw new Error('A retry must have a request id');
    }
    ui.onServerMessage({ type: 'complete', requestId: 'stale-request' });
    expect(ui.state.status).toBe('streaming');
    expect(ui.resizeHandle.classList.contains('ht-hidden')).toBe(true);

    ui.onServerMessage({ type: 'complete', requestId: currentRequestId });
    expect(ui.state.status).toBe('complete');
    expect(ui.resizeHandle.classList.contains('ht-hidden')).toBe(false);
    expect(ui.sizeState.mode).toEqual({ kind: 'user', target: { width: 560, height: 420 } });
  });

  it('clears the inline size and returns to automatic mode when the card closes', () => {
    ui.sizeState = {
      mode: { kind: 'user', target: { width: 560, height: 420 } },
      resize: { kind: 'idle' },
    };
    ui.applyUserCardSize();
    ui.close(false);

    expect(ui.sizeState).toEqual({ mode: { kind: 'auto' }, resize: { kind: 'idle' } });
    expect(ui.card.style.width).toBe('');
    expect(ui.card.style.height).toBe('');
    expect(ui.card.dataset.sizeMode).toBeUndefined();
  });

  it('clears the user size when a new selection replaces the current card', () => {
    ui.sizeState = {
      mode: { kind: 'user', target: { width: 560, height: 420 } },
      resize: { kind: 'idle' },
    };
    ui.applyUserCardSize();

    const paragraph = document.createElement('p');
    paragraph.textContent = 'New selection';
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    ui.captureSelection(paragraph);

    expect(ui.sizeState).toEqual({ mode: { kind: 'auto' }, resize: { kind: 'idle' } });
    expect(ui.card.style.width).toBe('');
    expect(ui.card.style.height).toBe('');
    expect(ui.card.dataset.sizeMode).toBeUndefined();
    expect(ui.activeSelection?.text).toBe('New selection');

    selection?.removeAllRanges();
    paragraph.remove();
  });
});
