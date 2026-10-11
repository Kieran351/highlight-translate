// @vitest-environment happy-dom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

class TestResizeObserver {
  observe(): void {}

  disconnect(): void {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver);
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
  callback(0);
  return 1;
});

const { mountHighlightTranslateUi } = await import('../../src/content/highlight-translate-ui');

interface TestUi {
  host: HTMLElement;
  activeSelection: { text: string; range: Range } | null;
  close(): void;
  captureSelection(eventTarget: EventTarget | null): void;
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

afterAll(() => {
  ui.host.remove();
});

beforeEach(() => {
  ui.close();
  ui.activeSelection = null;
});

describe('content script selection UI', () => {
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
