import { createCardPositionState, reduceCardPosition } from './card-position';
import type { CardPositionState } from './card-position';
import { createCardSizeState, reduceCardSize, resolveUserCardSize } from './card-size';
import type { CardSizeState } from './card-size';
import { getRangeEndpointRect, placeOverlay } from './geometry';
import type { AnchorRect, OverlayPoint, OverlaySize, ViewportSize } from './geometry';
import type { RequestActivity } from './card-state';

export interface CardInteractionElements {
  host: HTMLElement;
  trigger: HTMLElement;
  card: HTMLElement;
  header: HTMLElement;
  closeButton: HTMLElement;
  resizeHandle: HTMLElement;
}

export interface CardInteractionEnvironment {
  viewport(): ViewportSize;
  cardSize(card: HTMLElement): OverlaySize;
  cardOrigin(card: HTMLElement): OverlayPoint;
  anchorRect(range: Range): AnchorRect;
  requestFrame(callback: () => void): void;
  observeResize(target: HTMLElement, callback: () => void): () => void;
}

export interface CardInteraction {
  showTrigger(anchor: Range): void;
  openCard(): void;
  hide(): void;
  setRequestActivity(activity: RequestActivity): void;
  consumeGestureMouseUp(event: MouseEvent): boolean;
  dispose(): void;
}

const DEFAULT_ENVIRONMENT: CardInteractionEnvironment = {
  viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  cardSize: (card) => ({ width: card.offsetWidth, height: card.offsetHeight }),
  cardOrigin: (card) => {
    const rect = card.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  },
  anchorRect: getRangeEndpointRect,
  requestFrame: (callback) => { window.requestAnimationFrame(() => callback()); },
  observeResize: (target, callback) => {
    const observer = new ResizeObserver(callback);
    observer.observe(target);
    return () => observer.disconnect();
  },
};

export function createCardInteraction(
  elements: CardInteractionElements,
  overrides: Partial<CardInteractionEnvironment> = {},
): CardInteraction {
  const environment = { ...DEFAULT_ENVIRONMENT, ...overrides };
  let positionState: CardPositionState = createCardPositionState();
  let sizeState: CardSizeState = createCardSizeState();
  let requestActivity: RequestActivity = 'stopped';
  let anchor: Range | null = null;
  let suppressNextMouseUp = false;
  let positionFrameScheduled = false;
  let disposed = false;

  function updateDragFeedback(): void {
    if (positionState.drag.kind === 'dragging') {
      elements.header.dataset.dragState = 'dragging';
    } else if (requestActivity === 'stopped') {
      elements.header.dataset.dragState = 'ready';
    } else {
      elements.header.dataset.dragState = 'disabled';
    }
  }

  function updateResizeFeedback(): void {
    const active = requestActivity === 'active';
    elements.resizeHandle.classList.toggle('ht-hidden', active);
    elements.resizeHandle.dataset.resizeState = active
      ? 'disabled'
      : sizeState.resize.kind === 'resizing' ? 'resizing' : 'ready';
  }

  function cardSize(): OverlaySize {
    return environment.cardSize(elements.card);
  }

  function schedulePosition(): void {
    if (disposed || positionFrameScheduled) {
      return;
    }

    positionFrameScheduled = true;
    environment.requestFrame(() => {
      positionFrameScheduled = false;
      if (!disposed) {
        position();
      }
    });
  }

  function applyUserCardSize(): void {
    const resolved = resolveUserCardSize(sizeState, environment.viewport());
    if (!resolved) {
      elements.card.style.removeProperty('width');
      elements.card.style.removeProperty('height');
      elements.card.removeAttribute('data-size-mode');
      return;
    }

    elements.card.dataset.sizeMode = 'user';
    const width = `${resolved.width}px`;
    const height = `${resolved.height}px`;
    if (elements.card.style.width !== width) {
      elements.card.style.width = width;
    }
    if (elements.card.style.height !== height) {
      elements.card.style.height = height;
    }
  }

  function position(): void {
    if (!anchor) {
      return;
    }

    const cardHidden = elements.card.classList.contains('ht-hidden');
    const overlay = cardHidden ? elements.trigger : elements.card;
    if (!cardHidden) {
      applyUserCardSize();
    }

    if (cardHidden || positionState.position.kind === 'anchored') {
      let rect: AnchorRect;
      try {
        rect = environment.anchorRect(anchor);
      } catch {
        return;
      }

      const size = cardHidden ? { width: 42, height: 42 } : cardSize();
      const anchored = placeOverlay(rect, size, environment.viewport(), 8);
      overlay.style.left = `${anchored.x}px`;
      overlay.style.top = `${anchored.y}px`;
      overlay.style.visibility = anchored.visible ? 'visible' : 'hidden';
      return;
    }

    positionState = reduceCardPosition(positionState, {
      type: 'layout-changed',
      cardSize: cardSize(),
      viewport: environment.viewport(),
    });
    const free = positionState.position;
    if (free.kind === 'free') {
      overlay.style.left = `${free.x}px`;
      overlay.style.top = `${free.y}px`;
      overlay.style.visibility = 'visible';
    }
  }

  function releaseResizePointer(pointerId: number): void {
    try {
      elements.resizeHandle.releasePointerCapture(pointerId);
    } catch {
      return;
    }
  }

  function releaseResizeSession(): void {
    const resize = sizeState.resize;
    if (resize.kind !== 'idle') {
      releaseResizePointer(resize.pointerId);
    }
  }

  function releasePointerSession(): void {
    const drag = positionState.drag;
    if (drag.kind === 'idle') {
      return;
    }

    try {
      elements.header.releasePointerCapture(drag.pointerId);
    } catch {
      return;
    }
  }

  function resetPositionState(): void {
    releasePointerSession();
    positionState = createCardPositionState();
    suppressNextMouseUp = false;
    updateDragFeedback();
  }

  function resetCardSizeState(): void {
    releaseResizeSession();
    sizeState = createCardSizeState();
    elements.card.style.removeProperty('width');
    elements.card.style.removeProperty('height');
    elements.card.removeAttribute('data-size-mode');
    updateResizeFeedback();
  }

  function onHeaderPointerDown(event: PointerEvent): void {
    if (event.composedPath().includes(elements.closeButton)) {
      return;
    }

    const next = reduceCardPosition(positionState, {
      type: 'pointer-down',
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      button: event.button,
      pointer: { x: event.clientX, y: event.clientY },
      card: environment.cardOrigin(elements.card),
      requestActivity,
    });
    if (next === positionState) {
      return;
    }

    positionState = next;
    try {
      elements.header.setPointerCapture(event.pointerId);
    } catch {
      positionState = reduceCardPosition(positionState, {
        type: 'pointer-cancel',
        pointerId: event.pointerId,
      });
    }
    updateDragFeedback();
  }

  function onHeaderPointerMove(event: PointerEvent): void {
    if (positionState.drag.kind === 'idle') {
      return;
    }

    positionState = reduceCardPosition(positionState, {
      type: 'pointer-move',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      cardSize: cardSize(),
      viewport: environment.viewport(),
    });
    updateDragFeedback();
    schedulePosition();
  }

  function onHeaderPointerUp(event: PointerEvent): void {
    if (positionState.drag.kind === 'idle') {
      return;
    }

    const wasDragging = positionState.drag.kind === 'dragging';
    positionState = reduceCardPosition(positionState, {
      type: 'pointer-up',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      cardSize: cardSize(),
      viewport: environment.viewport(),
    });
    if (wasDragging && positionState.drag.kind === 'idle') {
      suppressNextMouseUp = true;
    }
    updateDragFeedback();
    schedulePosition();
  }

  function onHeaderPointerCancel(event: PointerEvent): void {
    positionState = reduceCardPosition(positionState, {
      type: 'pointer-cancel',
      pointerId: event.pointerId,
    });
    updateDragFeedback();
  }

  function onHeaderCaptureLost(event: PointerEvent): void {
    positionState = reduceCardPosition(positionState, {
      type: 'capture-lost',
      pointerId: event.pointerId,
    });
    updateDragFeedback();
  }

  function onResizePointerDown(event: PointerEvent): void {
    const next = reduceCardSize(sizeState, {
      type: 'pointer-down',
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      button: event.button,
      pointer: { x: event.clientX, y: event.clientY },
      cardSize: cardSize(),
      requestActivity,
    });
    if (next === sizeState) {
      return;
    }

    event.preventDefault();
    sizeState = next;
    try {
      elements.resizeHandle.setPointerCapture(event.pointerId);
    } catch {
      sizeState = reduceCardSize(sizeState, {
        type: 'pointer-cancel',
        pointerId: event.pointerId,
      });
    }
    updateResizeFeedback();
  }

  function onResizePointerMove(event: PointerEvent): void {
    if (sizeState.resize.kind === 'idle' || sizeState.resize.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const wasResizing = sizeState.resize.kind === 'resizing';
    const previous = sizeState;
    sizeState = reduceCardSize(sizeState, {
      type: 'pointer-move',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      viewport: environment.viewport(),
    });
    if (sizeState.resize.kind === 'idle') {
      releaseResizePointer(event.pointerId);
      if (wasResizing) {
        suppressNextMouseUp = true;
      }
    }
    updateResizeFeedback();
    if (sizeState !== previous) {
      schedulePosition();
    }
  }

  function onResizePointerUp(event: PointerEvent): void {
    if (sizeState.resize.kind === 'idle' || sizeState.resize.pointerId !== event.pointerId) {
      return;
    }

    const wasResizing = sizeState.resize.kind === 'resizing';
    const wasPending = sizeState.resize.kind === 'pending';
    sizeState = reduceCardSize(sizeState, {
      type: 'pointer-up',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      viewport: environment.viewport(),
    });
    releaseResizePointer(event.pointerId);
    if (wasResizing || (wasPending && sizeState.mode.kind === 'user')) {
      suppressNextMouseUp = true;
    }
    updateResizeFeedback();
    schedulePosition();
  }

  function onResizePointerCancel(event: PointerEvent): void {
    if (sizeState.resize.kind === 'idle' || sizeState.resize.pointerId !== event.pointerId) {
      return;
    }

    const wasResizing = sizeState.resize.kind === 'resizing';
    sizeState = reduceCardSize(sizeState, {
      type: 'pointer-cancel',
      pointerId: event.pointerId,
    });
    releaseResizePointer(event.pointerId);
    if (wasResizing) {
      suppressNextMouseUp = true;
    }
    updateResizeFeedback();
  }

  function onResizeCaptureLost(event: PointerEvent): void {
    if (sizeState.resize.kind === 'idle' || sizeState.resize.pointerId !== event.pointerId) {
      return;
    }

    const wasResizing = sizeState.resize.kind === 'resizing';
    sizeState = reduceCardSize(sizeState, {
      type: 'capture-lost',
      pointerId: event.pointerId,
    });
    if (wasResizing) {
      suppressNextMouseUp = true;
    }
    updateResizeFeedback();
  }

  function onWindowBlur(): void {
    if (sizeState.resize.kind === 'resizing') {
      suppressNextMouseUp = true;
    }
    releaseResizeSession();
    sizeState = reduceCardSize(sizeState, { type: 'window-blur' });
    positionState = reduceCardPosition(positionState, { type: 'window-blur' });
    updateDragFeedback();
    updateResizeFeedback();
  }

  const headerListeners: Array<[string, EventListener]> = [
    ['pointerdown', (event) => onHeaderPointerDown(event as PointerEvent)],
    ['pointermove', (event) => onHeaderPointerMove(event as PointerEvent)],
    ['pointerup', (event) => onHeaderPointerUp(event as PointerEvent)],
    ['pointercancel', (event) => onHeaderPointerCancel(event as PointerEvent)],
    ['lostpointercapture', (event) => onHeaderCaptureLost(event as PointerEvent)],
  ];
  const resizeListeners: Array<[string, EventListener]> = [
    ['pointerdown', (event) => onResizePointerDown(event as PointerEvent)],
    ['pointermove', (event) => onResizePointerMove(event as PointerEvent)],
    ['pointerup', (event) => onResizePointerUp(event as PointerEvent)],
    ['pointercancel', (event) => onResizePointerCancel(event as PointerEvent)],
    ['lostpointercapture', (event) => onResizeCaptureLost(event as PointerEvent)],
  ];
  const onWindowScroll = (): void => schedulePosition();
  const onWindowResize = (): void => schedulePosition();

  for (const [type, listener] of headerListeners) {
    elements.header.addEventListener(type, listener);
  }
  for (const [type, listener] of resizeListeners) {
    elements.resizeHandle.addEventListener(type, listener);
  }
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('scroll', onWindowScroll, true);
  window.addEventListener('resize', onWindowResize);
  const stopObservingResize = environment.observeResize(elements.card, schedulePosition);
  updateDragFeedback();
  updateResizeFeedback();

  return {
    showTrigger(nextAnchor) {
      resetPositionState();
      resetCardSizeState();
      anchor = nextAnchor;
      elements.card.classList.add('ht-hidden');
      elements.trigger.classList.remove('ht-hidden');
      schedulePosition();
    },
    openCard() {
      if (disposed || !anchor) {
        return;
      }
      elements.trigger.classList.add('ht-hidden');
      elements.card.classList.remove('ht-hidden');
      schedulePosition();
    },
    hide() {
      resetPositionState();
      resetCardSizeState();
      anchor = null;
      elements.trigger.classList.add('ht-hidden');
      elements.card.classList.add('ht-hidden');
    },
    setRequestActivity(activity) {
      if (disposed || requestActivity === activity) {
        return;
      }

      requestActivity = activity;
      if (activity === 'active') {
        if (sizeState.resize.kind === 'resizing') {
          suppressNextMouseUp = true;
        }
        releaseResizeSession();
        sizeState = reduceCardSize(sizeState, { type: 'request-started' });
        positionState = reduceCardPosition(positionState, { type: 'request-started' });
      }
      updateDragFeedback();
      updateResizeFeedback();
      schedulePosition();
    },
    consumeGestureMouseUp(event) {
      if (event.composedPath().includes(elements.host)) {
        suppressNextMouseUp = false;
        return true;
      }
      if (suppressNextMouseUp) {
        suppressNextMouseUp = false;
        return true;
      }
      return false;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const [type, listener] of headerListeners) {
        elements.header.removeEventListener(type, listener);
      }
      for (const [type, listener] of resizeListeners) {
        elements.resizeHandle.removeEventListener(type, listener);
      }
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('scroll', onWindowScroll, true);
      window.removeEventListener('resize', onWindowResize);
      stopObservingResize();
    },
  };
}
