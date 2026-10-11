// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranslationDependencies } from '../../src/background/translation-session';
import { mountHighlightTranslateUi } from '../../src/content/highlight-translate-ui';
import type { HighlightTranslateUi, HighlightTranslateUiOptions } from '../../src/content/highlight-translate-ui';
import type { CardInteractionEnvironment } from '../../src/content/card-interaction';
import { pointerEvent } from '../helpers/pointer-event';
import { createSessionBridge } from '../helpers/session-bridge';

const mountedInstances = new Set<HighlightTranslateUi>();

interface UiFixture {
  ui: HighlightTranslateUi;
  host: HTMLElement;
  shadow: ShadowRoot;
  trigger: HTMLButtonElement;
  card: HTMLElement;
  header: HTMLElement;
  resizeHandle: HTMLElement;
  result: HTMLElement;
  status: HTMLElement;
  copyButton: HTMLButtonElement;
  bridge: ReturnType<typeof createSessionBridge>;
  dispose(): void;
}

function required<T>(value: T | null, description: string): T {
  if (value === null) {
    throw new Error(`Expected ${description}`);
  }
  return value;
}

function testEnvironment(): Partial<CardInteractionEnvironment> {
  return {
    viewport: () => ({ width: 1_000, height: 800 }),
    cardSize: (card) => ({
      width: Number.parseFloat(card.style.width) || 480,
      height: Number.parseFloat(card.style.height) || 300,
    }),
    cardOrigin: (card) => ({
      x: Number.parseFloat(card.style.left) || 100,
      y: Number.parseFloat(card.style.top) || 120,
    }),
    anchorRect: () => ({ left: 50, right: 60, top: 70, bottom: 80 }),
    requestFrame: (callback) => callback(),
    observeResize: () => () => undefined,
  };
}

function uiOptions(
  bridge: ReturnType<typeof createSessionBridge>,
  shadowMode?: ShadowRootMode,
): HighlightTranslateUiOptions {
  return {
    ...(shadowMode ? { shadowMode } : {}),
    environment: testEnvironment(),
    connect: bridge.connect,
    createRequestId: (() => {
      let requestId = 0;
      return () => `ui-request-${++requestId}`;
    })(),
  };
}

function mountFixture(
  streamTranslation?: TranslationDependencies['streamTranslation'],
): UiFixture {
  const bridge = createSessionBridge(streamTranslation ? { streamTranslation } : {});
  const ui = mountHighlightTranslateUi(uiOptions(bridge, 'open'));
  if (!ui) {
    throw new Error('Expected UI to mount in a top-level document');
  }
  mountedInstances.add(ui);

  const host = required(document.querySelector<HTMLElement>('[data-highlight-translate-root]'), 'translation host');
  const shadow = required(host.shadowRoot, 'open shadow root');
  const trigger = required(shadow.querySelector<HTMLButtonElement>('.ht-trigger'), 'translation trigger');
  const card = required(shadow.querySelector<HTMLElement>('.ht-card'), 'translation card');
  const header = required(shadow.querySelector<HTMLElement>('.ht-header'), 'translation header');
  const resizeHandle = required(shadow.querySelector<HTMLElement>('.ht-resize-handle'), 'resize handle');
  const result = required(shadow.querySelector<HTMLElement>('.ht-result'), 'translation result');
  const status = required(shadow.querySelector<HTMLElement>('.ht-status'), 'translation status');
  const copyButton = required(shadow.querySelector<HTMLButtonElement>('.ht-actions .ht-button--primary'), 'copy button');
  header.setPointerCapture = vi.fn();
  header.releasePointerCapture = vi.fn();
  resizeHandle.setPointerCapture = vi.fn();
  resizeHandle.releasePointerCapture = vi.fn();

  return {
    ui,
    host,
    shadow,
    trigger,
    card,
    header,
    resizeHandle,
    result,
    status,
    copyButton,
    bridge,
    dispose() {
      ui.dispose();
      mountedInstances.delete(ui);
    },
  };
}

function selectPageText(text: string): HTMLParagraphElement {
  const paragraph = document.createElement('p');
  paragraph.dataset.highlightTranslateTestPage = '';
  paragraph.textContent = text;
  document.body.append(paragraph);

  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error('Expected a page selection');
  }
  selection.removeAllRanges();
  selection.addRange(range);
  paragraph.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
  }));
  return paragraph;
}

function dispatchPointer(target: HTMLElement, type: string, data: Parameters<typeof pointerEvent>[1] = {}): Event {
  const event = pointerEvent(type, { ...data, composed: true });
  target.dispatchEvent(event);
  return event;
}

function dispatchMouseUp(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
  }));
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
}

afterEach(() => {
  for (const ui of [...mountedInstances]) {
    ui.dispose();
  }
  mountedInstances.clear();
  document.querySelectorAll('[data-highlight-translate-test-page]').forEach((page) => page.remove());
  window.getSelection()?.removeAllRanges();
});

describe('HighlightTranslateUi', () => {
  it('keeps the production shadow root closed and mounts one host', () => {
    const bridge = createSessionBridge();
    const ui = mountHighlightTranslateUi(uiOptions(bridge));
    if (!ui) {
      throw new Error('Expected UI to mount in a top-level document');
    }
    mountedInstances.add(ui);
    const host = required(document.querySelector<HTMLElement>('[data-highlight-translate-root]'), 'translation host');

    expect(host.shadowRoot).toBeNull();
    expect(document.querySelectorAll('[data-highlight-translate-root]')).toHaveLength(1);
  });

  it('shows a trigger for a page selection and sends the complete selection after opening it', async () => {
    const fixture = mountFixture();
    const selectedText = 'Full selected text';
    selectPageText(selectedText);
    await waitFor(() => expect(fixture.trigger.classList.contains('ht-hidden')).toBe(false));

    fixture.trigger.click();
    await waitFor(() => expect(fixture.result.textContent).toBe('译文'));

    expect(fixture.card.classList.contains('ht-hidden')).toBe(false);
    expect(fixture.bridge.connections[0]?.clientMessages).toContainEqual({
      type: 'translate',
      requestId: 'ui-request-1',
      text: selectedText,
    });
  });

  it.each(['drag', 'resize'])('keeps the card open after a completed %s and an outside mouseup', async (gesture) => {
    const fixture = mountFixture();
    selectPageText('Selected for drag');
    await waitFor(() => expect(fixture.trigger.classList.contains('ht-hidden')).toBe(false));
    fixture.trigger.click();
    await waitFor(() => expect(fixture.result.textContent).toBe('译文'));

    if (gesture === 'drag') {
      const startingLeft = fixture.card.style.left;
      dispatchPointer(fixture.header, 'pointerdown', { pointerId: 1, clientX: 400, clientY: 300 });
      dispatchPointer(fixture.header, 'pointermove', { pointerId: 1, clientX: 420, clientY: 320 });
      dispatchPointer(fixture.header, 'pointerup', { pointerId: 1, clientX: 420, clientY: 320, buttons: 0 });
      expect(fixture.card.style.left).not.toBe(startingLeft);
    } else {
      dispatchPointer(fixture.resizeHandle, 'pointerdown', { pointerId: 2, clientX: 400, clientY: 300 });
      dispatchPointer(fixture.resizeHandle, 'pointermove', { pointerId: 2, clientX: 430, clientY: 330 });
      dispatchPointer(fixture.resizeHandle, 'pointerup', { pointerId: 2, clientX: 430, clientY: 330, buttons: 0 });
      expect(fixture.card.style.width).toBe('510px');
      expect(fixture.card.style.height).toBe('330px');
      expect(fixture.card.dataset.sizeMode).toBe('user');
    }

    dispatchMouseUp(document.body);
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

    expect(fixture.card.classList.contains('ht-hidden')).toBe(false);
    expect(fixture.trigger.classList.contains('ht-hidden')).toBe(true);
    expect(fixture.bridge.connections[0]?.clientMessages.filter((message) => message.type === 'translate')).toHaveLength(1);
  });

  it('accepts a new page selection after consuming a host mouseup', async () => {
    const fixture = mountFixture();
    selectPageText('First selection');
    await waitFor(() => expect(fixture.trigger.classList.contains('ht-hidden')).toBe(false));
    fixture.trigger.click();
    await waitFor(() => expect(fixture.result.textContent).toBe('译文'));

    dispatchPointer(fixture.header, 'pointerdown', { pointerId: 2, clientX: 400, clientY: 300 });
    dispatchPointer(fixture.header, 'pointermove', { pointerId: 2, clientX: 420, clientY: 320 });
    dispatchPointer(fixture.header, 'pointerup', { pointerId: 2, clientX: 420, clientY: 320, buttons: 0 });
    dispatchMouseUp(fixture.header);
    await flushMicrotasks();
    expect(fixture.card.classList.contains('ht-hidden')).toBe(false);
    expect(fixture.trigger.classList.contains('ht-hidden')).toBe(true);

    const nextSelection = 'Second selection';
    selectPageText(nextSelection);
    await waitFor(() => expect(fixture.trigger.classList.contains('ht-hidden')).toBe(false));

    expect(fixture.card.classList.contains('ht-hidden')).toBe(true);
    expect(fixture.bridge.connections[0]?.clientMessages.filter((message) => message.type === 'translate')).toHaveLength(1);
  });

  it.each(['Escape', 'outside pointerdown'])('%s closes the card and cancels the active request', async (closeAction) => {
    const streamTranslation: TranslationDependencies['streamTranslation'] = ({ onChunk, signal }) => {
      onChunk('部分译文');
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const fixture = mountFixture(streamTranslation);
    selectPageText('Selection to cancel');
    await waitFor(() => expect(fixture.trigger.classList.contains('ht-hidden')).toBe(false));
    fixture.trigger.click();
    await waitFor(() => expect(fixture.result.textContent).toBe('部分译文'));

    if (closeAction === 'Escape') {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    } else {
      document.body.dispatchEvent(new Event('pointerdown', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }
    await waitFor(() => expect(fixture.card.classList.contains('ht-hidden')).toBe(true));
    await waitFor(() => expect(fixture.bridge.connections[0]?.fakePort.messages.at(-1)?.type).toBe('cancelled'));

    expect(fixture.result.textContent).toBe('');
    expect(fixture.bridge.connections[0]?.clientMessages).toContainEqual({
      type: 'cancel',
      requestId: 'ui-request-1',
    });
  });

  it.each(['resolve', 'reject'])('ignores a clipboard %s after dispose', async (settlement) => {
    const fixture = mountFixture();
    selectPageText('Copy selection');
    await waitFor(() => expect(fixture.trigger.classList.contains('ht-hidden')).toBe(false));
    fixture.trigger.click();
    await waitFor(() => expect(fixture.result.textContent).toBe('译文'));
    expect(fixture.copyButton.disabled).toBe(false);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let settle!: () => void;
    const pendingWrite = new Promise<void>((resolve, reject) => {
      settle = settlement === 'resolve' ? () => resolve() : () => reject(new Error('clipboard failed'));
    });
    const writeText = vi.fn(() => pendingWrite);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const buttonText = fixture.copyButton.textContent;
    const statusText = fixture.status.textContent;
    const statusTone = fixture.status.dataset.tone;

    try {
      fixture.copyButton.click();
      expect(writeText).toHaveBeenCalledWith('译文');
      fixture.ui.dispose();
      mountedInstances.delete(fixture.ui);
      timeoutSpy.mockClear();
      settle();
      await flushMicrotasks();

      expect(fixture.copyButton.textContent).toBe(buttonText);
      expect(fixture.status.textContent).toBe(statusText);
      expect(fixture.status.dataset.tone).toBe(statusTone);
      expect(timeoutSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });
});
