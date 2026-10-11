// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';

import { createCardInteraction } from '../../src/content/card-interaction';
import type { CardInteraction, CardInteractionElements, CardInteractionEnvironment } from '../../src/content/card-interaction';
import type { AnchorRect, ViewportSize } from '../../src/content/geometry';
import { pointerEvent } from '../helpers/pointer-event';

interface Fixture {
  elements: CardInteractionElements;
  interaction: CardInteraction;
  requestFrame: ReturnType<typeof vi.fn>;
  resizeCallback: () => void;
  resizeCleanup: ReturnType<typeof vi.fn>;
  setAnchorRect(rect: AnchorRect): void;
  setViewport(viewport: ViewportSize): void;
  dispose(): void;
}

function fixture(options: { productionFrame?: boolean } = {}): Fixture {
  const host = document.createElement('div');
  const trigger = document.createElement('button');
  const card = document.createElement('section');
  const header = document.createElement('header');
  const closeButton = document.createElement('button');
  const resizeHandle = document.createElement('span');
  trigger.className = 'ht-trigger ht-hidden';
  card.className = 'ht-card ht-hidden';
  header.className = 'ht-header';
  resizeHandle.className = 'ht-resize-handle';
  header.append(closeButton);
  card.append(header, resizeHandle);
  host.append(trigger, card);
  document.body.append(host);

  const elements = { host, trigger, card, header, closeButton, resizeHandle };
  header.setPointerCapture = vi.fn();
  header.releasePointerCapture = vi.fn();
  resizeHandle.setPointerCapture = vi.fn();
  resizeHandle.releasePointerCapture = vi.fn();

  let viewport: ViewportSize = { width: 1_000, height: 800 };
  let anchor: AnchorRect = { left: 50, right: 60, top: 70, bottom: 80 };
  let resizeCallback = (): void => undefined;
  const resizeCleanup = vi.fn();
  const requestFrame = vi.fn((callback: () => void) => callback());
  const environment: Partial<CardInteractionEnvironment> = {
    viewport: () => ({ ...viewport }),
    cardSize: (target) => ({
      width: Number.parseFloat(target.style.width) || 480,
      height: Number.parseFloat(target.style.height) || 300,
    }),
    cardOrigin: (target) => ({
      x: Number.parseFloat(target.style.left) || 100,
      y: Number.parseFloat(target.style.top) || 120,
    }),
    anchorRect: () => ({ ...anchor }),
    observeResize: (_target, callback) => {
      resizeCallback = callback;
      return resizeCleanup;
    },
    ...(options.productionFrame ? {} : { requestFrame }),
  };

  const interaction = createCardInteraction(elements, environment);
  return {
    elements,
    interaction,
    requestFrame,
    get resizeCallback() { return resizeCallback; },
    resizeCleanup,
    setAnchorRect(rect) { anchor = rect; },
    setViewport(size) { viewport = size; },
    dispose() {
      interaction.dispose();
      host.remove();
    },
  };
}

function openCard(value: Fixture): void {
  value.interaction.showTrigger({} as Range);
  value.interaction.openCard();
}

function pointer(target: HTMLElement, type: string, data: Parameters<typeof pointerEvent>[1] = {}): Event {
  const event = pointerEvent(type, data);
  target.dispatchEvent(event);
  return event;
}

function finishDrag(value: Fixture, pointerId = 21): void {
  const { header } = value.elements;
  pointer(header, 'pointerdown', { pointerId });
  pointer(header, 'pointermove', { pointerId, clientX: 410, clientY: 310 });
  pointer(header, 'pointerup', { pointerId, clientX: 410, clientY: 310, buttons: 0 });
}

function consumeMouseUp(value: Fixture, target: HTMLElement): { consumed: boolean | undefined; event: MouseEvent } {
  let consumed: boolean | undefined;
  const listener = (event: MouseEvent): void => {
    consumed = value.interaction.consumeGestureMouseUp(event);
  };
  const event = new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 });
  document.addEventListener('mouseup', listener, true);
  target.dispatchEvent(event);
  document.removeEventListener('mouseup', listener, true);
  return { consumed, event };
}

describe('CardInteraction', () => {
  it('shows the resize handle only while stopped and captures valid mouse input', () => {
    const value = fixture();
    openCard(value);
    const { resizeHandle } = value.elements;
    value.interaction.setRequestActivity('active');
    expect(resizeHandle.classList.contains('ht-hidden')).toBe(true);
    expect(resizeHandle.dataset.resizeState).toBe('disabled');
    const activeDown = pointer(resizeHandle, 'pointerdown', { pointerId: 1 });
    expect(activeDown.defaultPrevented).toBe(false);
    expect(resizeHandle.setPointerCapture).not.toHaveBeenCalled();

    value.interaction.setRequestActivity('stopped');
    expect(resizeHandle.classList.contains('ht-hidden')).toBe(false);
    expect(resizeHandle.dataset.resizeState).toBe('ready');
    pointer(resizeHandle, 'pointerdown', { pointerType: 'touch', pointerId: 2 });
    pointer(resizeHandle, 'pointerdown', { isPrimary: false, pointerId: 3 });
    expect(resizeHandle.setPointerCapture).not.toHaveBeenCalled();

    const validDown = pointer(resizeHandle, 'pointerdown', { pointerId: 4 });
    expect(validDown.defaultPrevented).toBe(true);
    expect(resizeHandle.setPointerCapture).toHaveBeenCalledWith(4);
    expect(resizeHandle.dataset.resizeState).toBe('ready');
    value.dispose();
  });

  it('resizes and preserves the user size after pointerup, cancel, capture loss and blur', () => {
    const value = fixture();
    openCard(value);
    const { card, resizeHandle } = value.elements;

    pointer(resizeHandle, 'pointerdown', { pointerId: 4 });
    const move = pointer(resizeHandle, 'pointermove', { pointerId: 4, clientX: 430, clientY: 330 });
    expect(move.defaultPrevented).toBe(true);
    expect(card.style.width).toBe('510px');
    expect(card.style.height).toBe('330px');
    expect(card.dataset.sizeMode).toBe('user');
    expect(resizeHandle.dataset.resizeState).toBe('resizing');

    pointer(resizeHandle, 'pointerup', { pointerId: 4, clientX: 460, clientY: 350, buttons: 0 });
    expect(card.style.width).toBe('540px');
    expect(card.style.height).toBe('350px');
    expect(resizeHandle.releasePointerCapture).toHaveBeenCalledWith(4);
    expect(resizeHandle.dataset.resizeState).toBe('ready');

    pointer(resizeHandle, 'pointerdown', { pointerId: 5 });
    pointer(resizeHandle, 'pointermove', { pointerId: 5, clientX: 420, clientY: 310 });
    pointer(resizeHandle, 'pointercancel', { pointerId: 5 });
    expect(card.style.width).toBe('560px');
    expect(card.style.height).toBe('360px');
    expect(card.dataset.sizeMode).toBe('user');
    expect(resizeHandle.dataset.resizeState).toBe('ready');

    pointer(resizeHandle, 'pointerdown', { pointerId: 6 });
    pointer(resizeHandle, 'pointermove', { pointerId: 6, clientX: 420, clientY: 310 });
    pointer(resizeHandle, 'lostpointercapture', { pointerId: 6 });
    expect(card.style.width).toBe('580px');
    expect(card.style.height).toBe('370px');
    expect(card.dataset.sizeMode).toBe('user');
    expect(resizeHandle.dataset.resizeState).toBe('ready');

    pointer(resizeHandle, 'pointerdown', { pointerId: 7 });
    pointer(resizeHandle, 'pointermove', { pointerId: 7, clientX: 420, clientY: 310 });
    window.dispatchEvent(new Event('blur'));
    expect(card.style.width).toBe('600px');
    expect(card.style.height).toBe('380px');
    expect(card.dataset.sizeMode).toBe('user');
    expect(resizeHandle.dataset.resizeState).toBe('ready');
    expect(resizeHandle.releasePointerCapture).toHaveBeenCalledWith(7);

    pointer(resizeHandle, 'pointerdown', { pointerId: 8 });
    pointer(resizeHandle, 'pointermove', { pointerId: 8, clientX: 410, clientY: 310 });
    expect(card.style.width).toBe('610px');
    expect(card.style.height).toBe('390px');
    expect(resizeHandle.dataset.resizeState).toBe('resizing');
    value.dispose();
  });

  it('ends resize when pointer capture cannot be established', () => {
    const value = fixture();
    openCard(value);
    const { card, resizeHandle } = value.elements;
    resizeHandle.setPointerCapture = vi.fn(() => { throw new Error('capture unavailable'); });

    pointer(resizeHandle, 'pointerdown', { pointerId: 8 });

    expect(card.style.width).toBe('');
    expect(card.style.height).toBe('');
    expect(card.dataset.sizeMode).toBeUndefined();
    expect(resizeHandle.dataset.resizeState).toBe('ready');

    resizeHandle.setPointerCapture = vi.fn();
    pointer(resizeHandle, 'pointerdown', { pointerId: 9 });
    pointer(resizeHandle, 'pointermove', { pointerId: 9, clientX: 430, clientY: 330 });
    expect(card.style.width).toBe('510px');
    expect(card.style.height).toBe('330px');
    expect(card.dataset.sizeMode).toBe('user');
    value.dispose();
  });

  it('keeps the user size, hides the handle, and consumes the mouseup when a request starts during resize', () => {
    const value = fixture();
    openCard(value);
    const { card, resizeHandle } = value.elements;
    pointer(resizeHandle, 'pointerdown', { pointerId: 9 });
    pointer(resizeHandle, 'pointermove', { pointerId: 9, clientX: 430, clientY: 330 });

    value.interaction.setRequestActivity('active');
    expect(card.style.width).toBe('510px');
    expect(card.style.height).toBe('330px');
    expect(card.dataset.sizeMode).toBe('user');
    expect(resizeHandle.classList.contains('ht-hidden')).toBe(true);
    expect(resizeHandle.dataset.resizeState).toBe('disabled');
    expect(resizeHandle.releasePointerCapture).toHaveBeenCalledWith(9);
    value.interaction.setRequestActivity('active');
    expect(resizeHandle.releasePointerCapture).toHaveBeenCalledTimes(1);

    value.interaction.setRequestActivity('stopped');
    expect(resizeHandle.classList.contains('ht-hidden')).toBe(false);
    expect(resizeHandle.dataset.resizeState).toBe('ready');
    expect(card.style.width).toBe('510px');
    expect(card.style.height).toBe('330px');
    expect(card.dataset.sizeMode).toBe('user');
    expect(consumeMouseUp(value, document.body).consumed).toBe(true);
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);
    value.dispose();
  });

  it('resets user size and gesture suppression when a new selection is shown or the card is hidden', () => {
    const value = fixture();
    openCard(value);
    const { card, trigger, resizeHandle } = value.elements;
    pointer(resizeHandle, 'pointerdown', { pointerId: 10 });
    pointer(resizeHandle, 'pointermove', { pointerId: 10, clientX: 430, clientY: 330 });
    pointer(resizeHandle, 'pointerup', { pointerId: 10, clientX: 430, clientY: 330, buttons: 0 });

    value.interaction.showTrigger({} as Range);
    expect(card.classList.contains('ht-hidden')).toBe(true);
    expect(trigger.classList.contains('ht-hidden')).toBe(false);
    expect(card.style.width).toBe('');
    expect(card.style.height).toBe('');
    expect(card.dataset.sizeMode).toBeUndefined();
    expect(trigger.style.left).toBe('68px');
    expect(trigger.style.top).toBe('88px');
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);

    value.interaction.openCard();
    pointer(resizeHandle, 'pointerdown', { pointerId: 11 });
    pointer(resizeHandle, 'pointermove', { pointerId: 11, clientX: 430, clientY: 330 });
    expect(card.dataset.sizeMode).toBe('user');
    value.interaction.hide();
    expect(card.classList.contains('ht-hidden')).toBe(true);
    expect(trigger.classList.contains('ht-hidden')).toBe(true);
    expect(card.style.width).toBe('');
    expect(card.style.height).toBe('');
    expect(card.dataset.sizeMode).toBeUndefined();
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);
    value.dispose();
  });

  it('drags from the header, keeps the free position on scroll, and ignores the close button', () => {
    const value = fixture();
    openCard(value);
    const { card, closeButton, header } = value.elements;

    pointer(closeButton, 'pointerdown', { pointerId: 20 });
    expect(header.setPointerCapture).not.toHaveBeenCalled();

    pointer(header, 'pointerdown', { pointerId: 21 });
    expect(header.setPointerCapture).toHaveBeenCalledWith(21);
    pointer(header, 'pointermove', { pointerId: 21, clientX: 410, clientY: 310 });
    expect(header.dataset.dragState).toBe('dragging');
    expect(card.style.left).toBe('78px');
    expect(card.style.top).toBe('98px');
    pointer(header, 'pointerup', { pointerId: 21, clientX: 410, clientY: 310, buttons: 0 });
    expect(header.dataset.dragState).toBe('ready');
    expect(header.releasePointerCapture).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('scroll'));
    expect(card.style.left).toBe('78px');
    expect(card.style.top).toBe('98px');
    value.setViewport({ width: 400, height: 250 });
    window.dispatchEvent(new Event('resize'));
    expect(card.style.left).toBe('8px');
    expect(card.style.top).toBe('8px');
    value.dispose();
  });

  it('consumes host mouseups and one outside mouseup after a completed drag', () => {
    const value = fixture();
    openCard(value);

    expect(consumeMouseUp(value, document.body).consumed).toBe(false);
    const hostMouseUp = consumeMouseUp(value, value.elements.closeButton);
    expect(hostMouseUp.consumed).toBe(true);
    expect(hostMouseUp.event.defaultPrevented).toBe(false);

    finishDrag(value, 22);
    expect(consumeMouseUp(value, value.elements.header).consumed).toBe(true);
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);

    finishDrag(value, 23);
    expect(consumeMouseUp(value, document.body).consumed).toBe(true);
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);

    finishDrag(value, 24);
    value.interaction.hide();
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);
    value.interaction.showTrigger({} as Range);
    value.interaction.openCard();
    finishDrag(value, 25);
    value.interaction.showTrigger({} as Range);
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);
    value.dispose();
  });

  it('repositions after card resize and hides overlays whose anchor is outside the viewport', () => {
    const value = fixture();
    openCard(value);
    const { card, trigger } = value.elements;
    expect(card.style.left).toBe('68px');
    expect(card.style.top).toBe('88px');

    value.setAnchorRect({ left: 900, right: 910, top: 700, bottom: 710 });
    value.resizeCallback();
    expect(card.style.left).toBe('412px');
    expect(card.style.top).toBe('392px');

    value.setAnchorRect({ left: 20, right: 30, top: -20, bottom: -10 });
    value.interaction.showTrigger({} as Range);
    expect(trigger.style.visibility).toBe('hidden');
    value.dispose();
  });

  it('coalesces production layout requests into one animation frame', () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    const value = fixture({ productionFrame: true });

    value.interaction.showTrigger({} as Range);
    value.interaction.openCard();
    window.dispatchEvent(new Event('resize'));
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(value.elements.card.style.left).toBe('');
    callbacks[0]?.(0);
    expect(value.elements.card.style.left).toBe('68px');

    value.dispose();
    vi.unstubAllGlobals();
  });

  it('removes pointer, window and resize observer callbacks on dispose', () => {
    const value = fixture();
    const { header, resizeHandle } = value.elements;
    const headerRemove = vi.spyOn(header, 'removeEventListener');
    const resizeRemove = vi.spyOn(resizeHandle, 'removeEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const frameCount = value.requestFrame.mock.calls.length;

    value.interaction.dispose();
    expect(value.resizeCleanup).toHaveBeenCalledOnce();
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      expect(headerRemove).toHaveBeenCalledWith(type, expect.any(Function));
      expect(resizeRemove).toHaveBeenCalledWith(type, expect.any(Function));
    }
    expect(windowRemove).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(windowRemove).toHaveBeenCalledWith('resize', expect.any(Function));

    pointer(header, 'pointerdown', { pointerId: 30 });
    window.dispatchEvent(new Event('resize'));
    value.resizeCallback();
    expect(header.setPointerCapture).not.toHaveBeenCalled();
    expect(value.requestFrame).toHaveBeenCalledTimes(frameCount);
    value.dispose();
  });

  it('ends dragging on blur or request start without explicitly releasing drag capture', () => {
    const value = fixture();
    openCard(value);
    const { header } = value.elements;
    pointer(header, 'pointerdown', { pointerId: 31 });
    pointer(header, 'pointermove', { pointerId: 31, clientX: 410, clientY: 310 });
    window.dispatchEvent(new Event('blur'));
    expect(header.dataset.dragState).toBe('ready');
    expect(header.releasePointerCapture).not.toHaveBeenCalled();
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);

    pointer(header, 'pointerdown', { pointerId: 32 });
    pointer(header, 'pointermove', { pointerId: 32, clientX: 420, clientY: 320 });
    value.interaction.setRequestActivity('active');
    expect(header.dataset.dragState).toBe('disabled');
    expect(header.releasePointerCapture).not.toHaveBeenCalled();
    expect(consumeMouseUp(value, document.body).consumed).toBe(false);
    value.dispose();
  });
});
