import styles from './content.css?inline';

import {
  applyServerMessage,
  beginRequest,
  beginRetry,
  canCopyResult,
  createCardState,
  getRequestActivity,
} from './card-state';
import type { CardState } from './card-state';
import { createCardPositionState, reduceCardPosition } from './card-position';
import type { CardPositionState } from './card-position';
import { createCardSizeState, reduceCardSize, resolveUserCardSize } from './card-size';
import type { CardSizeState } from './card-size';
import { endpointFromSelection, getRangeEndpointRect, placeOverlay } from './geometry';
import type { OverlaySize, ViewportSize } from './geometry';
import { evaluateSelection, isEditableNode } from './selection-policy';
import { PORT_NAME } from '../shared/constants';
import { getErrorPresentation } from '../shared/errors';
import type {
  ClientPortMessage,
  ExtensionMessage,
  ServerPortMessage,
} from '../shared/messages';
import { UI_TEXT } from '../shared/ui-text';

interface ActiveSelection {
  text: string;
  range: Range;
  tooLong: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  value.textContent = text;
  return value;
}

function isServerMessage(value: unknown): value is ServerPortMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.type === 'string'
    && typeof record.requestId === 'string'
    && ['route', 'chunk', 'complete', 'error', 'cancelled'].includes(record.type);
}

export class HighlightTranslateUi {
  private readonly host = document.createElement('div');
  private readonly shadow: ShadowRoot;
  private readonly trigger = element('button', 'ht-trigger ht-hidden', UI_TEXT.trigger);
  private readonly card = element('section', 'ht-card ht-hidden');
  private readonly header = element('header', 'ht-header');
  private readonly direction = element('span', 'ht-direction', UI_TEXT.detectingLanguage);
  private readonly result = element('div', 'ht-result');
  private readonly status = element('div', 'ht-status');
  private readonly retryButton = element('button', 'ht-button', UI_TEXT.retry);
  private readonly settingsButton = element('button', 'ht-button', UI_TEXT.openSettings);
  private readonly copyButton = element('button', 'ht-button ht-button--primary', UI_TEXT.copy);
  private readonly closeButton = element('button', 'ht-close', '×');
  private readonly resizeHandle = element('span', 'ht-resize-handle');
  private readonly cardResizeObserver = new ResizeObserver(() => this.schedulePosition());
  private activeSelection: ActiveSelection | null = null;
  private state: CardState = createCardState();
  private positionState: CardPositionState = createCardPositionState();
  private sizeState: CardSizeState = createCardSizeState();
  private port: chrome.runtime.Port | null = null;
  private followOutput = true;
  private positionFrame: number | null = null;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressNextMouseUp = false;

  constructor() {
    this.host.dataset.highlightTranslateRoot = '';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.shadow.append(style, this.trigger, this.card);
    document.documentElement.append(this.host);
    this.buildCard();
    this.bindEvents();
    this.cardResizeObserver.observe(this.card);
  }

  private buildCard(): void {
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', UI_TEXT.translationDialogLabel);

    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', UI_TEXT.closeTranslationLabel);
    this.header.append(this.direction, this.closeButton);

    this.result.setAttribute('role', 'region');
    this.result.setAttribute('aria-live', 'polite');
    this.result.tabIndex = 0;

    this.status.setAttribute('role', 'status');
    const actions = element('footer', 'ht-actions');
    const resizeGrip = element('span', 'ht-resize-grip');
    this.resizeHandle.setAttribute('aria-hidden', 'true');
    this.resizeHandle.append(resizeGrip);
    for (const button of [this.retryButton, this.settingsButton, this.copyButton]) {
      button.type = 'button';
    }
    this.retryButton.classList.add('ht-hidden');
    this.settingsButton.classList.add('ht-hidden');
    this.copyButton.disabled = true;
    actions.append(this.settingsButton, this.retryButton, this.copyButton);
    this.card.append(this.header, this.result, this.status, actions, this.resizeHandle);
  }

  private bindEvents(): void {
    this.trigger.addEventListener('mousedown', (event) => event.preventDefault());
    this.trigger.addEventListener('click', () => this.openCard());
    this.closeButton.addEventListener('click', () => this.close(true));
    this.retryButton.addEventListener('click', () => this.retry());
    this.settingsButton.addEventListener('click', () => {
      const message: ExtensionMessage = { type: 'open-options' };
      void chrome.runtime.sendMessage(message);
    });
    this.copyButton.addEventListener('click', () => this.copyResult());
    this.result.addEventListener('scroll', () => {
      const distanceFromBottom = this.result.scrollHeight - this.result.scrollTop - this.result.clientHeight;
      this.followOutput = distanceFromBottom <= 12;
    });

    document.addEventListener('mouseup', (event) => this.onMouseUp(event), true);
    document.addEventListener('pointerdown', (event) => {
      if (!event.composedPath().includes(this.host) && !this.card.classList.contains('ht-hidden')) {
        this.close(true);
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.card.classList.contains('ht-hidden')) {
        this.close(true);
      }
    }, true);
    this.header.addEventListener('pointerdown', (event) => this.onHeaderPointerDown(event));
    this.header.addEventListener('pointermove', (event) => this.onHeaderPointerMove(event));
    this.header.addEventListener('pointerup', (event) => this.onHeaderPointerUp(event));
    this.header.addEventListener('pointercancel', (event) => this.onHeaderPointerCancel(event));
    this.header.addEventListener('lostpointercapture', (event) => this.onHeaderCaptureLost(event));
    this.resizeHandle.addEventListener('pointerdown', (event) => this.onResizePointerDown(event));
    this.resizeHandle.addEventListener('pointermove', (event) => this.onResizePointerMove(event));
    this.resizeHandle.addEventListener('pointerup', (event) => this.onResizePointerUp(event));
    this.resizeHandle.addEventListener('pointercancel', (event) => this.onResizePointerCancel(event));
    this.resizeHandle.addEventListener('lostpointercapture', (event) => this.onResizeCaptureLost(event));
    window.addEventListener('blur', () => this.onWindowBlur());
    window.addEventListener('scroll', () => this.schedulePosition(), true);
    window.addEventListener('resize', () => this.schedulePosition());
  }

  private cardSize(): OverlaySize {
    return { width: this.card.offsetWidth, height: this.card.offsetHeight };
  }

  private viewportSize(): ViewportSize {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  private updateDragFeedback(): void {
    if (this.positionState.drag.kind === 'dragging') {
      this.header.dataset.dragState = 'dragging';
    } else if (getRequestActivity(this.state) === 'stopped') {
      this.header.dataset.dragState = 'ready';
    } else {
      this.header.dataset.dragState = 'disabled';
    }
  }

  private updateResizeFeedback(): void {
    const active = getRequestActivity(this.state) === 'active';
    this.resizeHandle.classList.toggle('ht-hidden', active);
    this.resizeHandle.dataset.resizeState = active
      ? 'disabled'
      : this.sizeState.resize.kind === 'resizing' ? 'resizing' : 'ready';
  }

  private onHeaderPointerDown(event: PointerEvent): void {
    if (event.composedPath().includes(this.closeButton)) {
      return;
    }

    const cardRect = this.card.getBoundingClientRect();
    const next = reduceCardPosition(this.positionState, {
      type: 'pointer-down',
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      button: event.button,
      pointer: { x: event.clientX, y: event.clientY },
      card: { x: cardRect.left, y: cardRect.top },
      requestActivity: getRequestActivity(this.state),
    });
    if (next === this.positionState) {
      return;
    }

    this.positionState = next;
    try {
      this.header.setPointerCapture(event.pointerId);
    } catch {
      this.positionState = reduceCardPosition(this.positionState, {
        type: 'pointer-cancel',
        pointerId: event.pointerId,
      });
    }
    this.updateDragFeedback();
  }

  private onHeaderPointerMove(event: PointerEvent): void {
    if (this.positionState.drag.kind === 'idle') {
      return;
    }

    this.positionState = reduceCardPosition(this.positionState, {
      type: 'pointer-move',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      cardSize: this.cardSize(),
      viewport: this.viewportSize(),
    });
    this.updateDragFeedback();
    this.schedulePosition();
  }

  private onHeaderPointerUp(event: PointerEvent): void {
    if (this.positionState.drag.kind === 'idle') {
      return;
    }

    const wasDragging = this.positionState.drag.kind === 'dragging';
    this.positionState = reduceCardPosition(this.positionState, {
      type: 'pointer-up',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      cardSize: this.cardSize(),
      viewport: this.viewportSize(),
    });
    if (wasDragging && this.positionState.drag.kind === 'idle') {
      this.suppressNextMouseUp = true;
    }
    this.updateDragFeedback();
    this.schedulePosition();
  }

  private onHeaderPointerCancel(event: PointerEvent): void {
    this.positionState = reduceCardPosition(this.positionState, {
      type: 'pointer-cancel',
      pointerId: event.pointerId,
    });
    this.updateDragFeedback();
  }

  private onHeaderCaptureLost(event: PointerEvent): void {
    this.positionState = reduceCardPosition(this.positionState, {
      type: 'capture-lost',
      pointerId: event.pointerId,
    });
    this.updateDragFeedback();
  }

  private onResizePointerDown(event: PointerEvent): void {
    const next = reduceCardSize(this.sizeState, {
      type: 'pointer-down',
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      button: event.button,
      pointer: { x: event.clientX, y: event.clientY },
      cardSize: this.cardSize(),
      requestActivity: getRequestActivity(this.state),
    });
    if (next === this.sizeState) {
      return;
    }

    event.preventDefault();
    this.sizeState = next;
    try {
      this.resizeHandle.setPointerCapture(event.pointerId);
    } catch {
      this.sizeState = reduceCardSize(this.sizeState, {
        type: 'pointer-cancel',
        pointerId: event.pointerId,
      });
    }
    this.updateResizeFeedback();
  }

  private onResizePointerMove(event: PointerEvent): void {
    if (
      this.sizeState.resize.kind === 'idle'
      || this.sizeState.resize.pointerId !== event.pointerId
    ) {
      return;
    }

    event.preventDefault();
    const wasResizing = this.sizeState.resize.kind === 'resizing';
    const previous = this.sizeState;
    this.sizeState = reduceCardSize(this.sizeState, {
      type: 'pointer-move',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      viewport: this.viewportSize(),
    });
    if (this.sizeState.resize.kind === 'idle') {
      this.releaseResizePointer(event.pointerId);
      if (wasResizing) {
        this.suppressNextMouseUp = true;
      }
    }
    this.updateResizeFeedback();
    if (this.sizeState !== previous) {
      this.schedulePosition();
    }
  }

  private onResizePointerUp(event: PointerEvent): void {
    if (
      this.sizeState.resize.kind === 'idle'
      || this.sizeState.resize.pointerId !== event.pointerId
    ) {
      return;
    }

    const wasResizing = this.sizeState.resize.kind === 'resizing';
    const wasPending = this.sizeState.resize.kind === 'pending';
    this.sizeState = reduceCardSize(this.sizeState, {
      type: 'pointer-up',
      pointerId: event.pointerId,
      buttons: event.buttons,
      pointer: { x: event.clientX, y: event.clientY },
      viewport: this.viewportSize(),
    });
    this.releaseResizePointer(event.pointerId);
    if (wasResizing || (wasPending && this.sizeState.mode.kind === 'user')) {
      this.suppressNextMouseUp = true;
    }
    this.updateResizeFeedback();
    this.schedulePosition();
  }

  private onResizePointerCancel(event: PointerEvent): void {
    if (
      this.sizeState.resize.kind === 'idle'
      || this.sizeState.resize.pointerId !== event.pointerId
    ) {
      return;
    }

    const wasResizing = this.sizeState.resize.kind === 'resizing';
    this.sizeState = reduceCardSize(this.sizeState, {
      type: 'pointer-cancel',
      pointerId: event.pointerId,
    });
    this.releaseResizePointer(event.pointerId);
    if (wasResizing) {
      this.suppressNextMouseUp = true;
    }
    this.updateResizeFeedback();
  }

  private onResizeCaptureLost(event: PointerEvent): void {
    if (
      this.sizeState.resize.kind === 'idle'
      || this.sizeState.resize.pointerId !== event.pointerId
    ) {
      return;
    }

    const wasResizing = this.sizeState.resize.kind === 'resizing';
    this.sizeState = reduceCardSize(this.sizeState, {
      type: 'capture-lost',
      pointerId: event.pointerId,
    });
    if (wasResizing) {
      this.suppressNextMouseUp = true;
    }
    this.updateResizeFeedback();
  }

  private onWindowBlur(): void {
    if (this.sizeState.resize.kind === 'resizing') {
      this.suppressNextMouseUp = true;
    }
    this.releaseResizeSession();
    this.sizeState = reduceCardSize(this.sizeState, { type: 'window-blur' });
    this.positionState = reduceCardPosition(this.positionState, { type: 'window-blur' });
    this.updateDragFeedback();
    this.updateResizeFeedback();
  }

  private releaseResizePointer(pointerId: number): void {
    try {
      this.resizeHandle.releasePointerCapture(pointerId);
    } catch {
      return;
    }
  }

  private releaseResizeSession(): void {
    const resize = this.sizeState.resize;
    if (resize.kind === 'idle') {
      return;
    }
    this.releaseResizePointer(resize.pointerId);
  }

  private releasePointerSession(): void {
    const drag = this.positionState.drag;
    if (drag.kind === 'idle') {
      return;
    }

    try {
      this.header.releasePointerCapture(drag.pointerId);
    } catch {
      return;
    }
  }

  private resetPositionState(): void {
    this.releasePointerSession();
    this.positionState = createCardPositionState();
    this.suppressNextMouseUp = false;
    this.updateDragFeedback();
  }

  private resetCardSizeState(): void {
    this.releaseResizeSession();
    this.sizeState = createCardSizeState();
    this.card.style.removeProperty('width');
    this.card.style.removeProperty('height');
    this.card.removeAttribute('data-size-mode');
    this.updateResizeFeedback();
  }

  private onMouseUp(event: MouseEvent): void {
    if (event.composedPath().includes(this.host)) {
      this.suppressNextMouseUp = false;
      return;
    }
    if (this.suppressNextMouseUp) {
      this.suppressNextMouseUp = false;
      return;
    }
    if (event.button !== 0) {
      return;
    }

    queueMicrotask(() => this.captureSelection(event.target));
  }

  private captureSelection(eventTarget: EventTarget | null): void {
    const selection = window.getSelection();
    const targetNode = eventTarget instanceof Node ? eventTarget : null;

    if (
      !selection
      || selection.rangeCount === 0
      || selection.isCollapsed
      || isEditableNode(targetNode)
      || isEditableNode(selection.anchorNode)
      || isEditableNode(selection.focusNode)
    ) {
      this.close(true);
      return;
    }

    const evaluation = evaluateSelection(selection.toString());
    const endpoint = endpointFromSelection(selection);
    if (evaluation.kind === 'invalid' || !endpoint) {
      this.close(true);
      return;
    }

    const endpointRange = selection.getRangeAt(0).cloneRange();
    endpointRange.setStart(endpoint.node, endpoint.offset);
    endpointRange.collapse(true);

    this.cancelActiveRequest();
    this.card.classList.add('ht-hidden');
    this.resetPositionState();
    this.resetCardSizeState();
    this.activeSelection = {
      text: evaluation.text,
      range: endpointRange,
      tooLong: evaluation.kind === 'too-long',
    };
    this.state = createCardState();
    this.trigger.classList.remove('ht-hidden');
    this.schedulePosition();
  }

  private openCard(): void {
    if (!this.activeSelection) {
      return;
    }

    this.trigger.classList.add('ht-hidden');
    this.card.classList.remove('ht-hidden');
    this.followOutput = true;

    if (this.activeSelection.tooLong) {
      const presentation = getErrorPresentation('too_long');
      this.state = {
        ...createCardState(),
        direction: UI_TEXT.unableToTranslate,
        status: 'error',
        errorMessage: presentation.message,
      };
      this.render();
      this.schedulePosition();
      return;
    }

    this.startRequest(false);
  }

  private ensurePort(): chrome.runtime.Port {
    if (this.port) {
      return this.port;
    }

    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((message: unknown) => this.onServerMessage(message));
    port.onDisconnect.addListener(() => {
      if (this.port !== port) {
        return;
      }
      this.port = null;
      if (this.state.status === 'streaming' && this.state.requestId) {
        this.onServerMessage({
          type: 'error',
          requestId: this.state.requestId,
          code: 'network',
          message: getErrorPresentation('network').message,
          retryable: true,
          partial: this.state.text.length > 0,
        });
      }
    });
    this.port = port;
    return port;
  }

  private startRequest(retry: boolean): void {
    if (!this.activeSelection) {
      return;
    }

    this.cancelActiveRequest();
    if (this.sizeState.resize.kind === 'resizing') {
      this.suppressNextMouseUp = true;
    }
    this.releaseResizeSession();
    this.sizeState = reduceCardSize(this.sizeState, { type: 'request-started' });
    const requestId = crypto.randomUUID().replaceAll('-', '');
    this.state = retry
      ? beginRetry(this.state, requestId)
      : beginRequest(this.state, requestId);
    this.positionState = reduceCardPosition(this.positionState, { type: 'request-started' });
    this.render();

    const message: ClientPortMessage = {
      type: 'translate',
      requestId,
      text: this.activeSelection.text,
    };
    this.ensurePort().postMessage(message);
  }

  private retry(): void {
    if (!this.state.retryable) {
      return;
    }
    this.startRequest(true);
  }

  private onServerMessage(message: unknown): void {
    if (!isServerMessage(message) || message.requestId !== this.state.requestId) {
      return;
    }

    const shouldFollow = this.followOutput;
    this.state = applyServerMessage(this.state, message);
    this.render();

    if (message.type === 'chunk' && shouldFollow) {
      this.result.scrollTop = this.result.scrollHeight;
      this.followOutput = true;
    }
  }

  private render(): void {
    this.direction.textContent = this.state.direction;
    this.result.textContent = this.state.text;
    this.copyButton.disabled = !canCopyResult(this.state);
    this.retryButton.classList.toggle('ht-hidden', !this.state.retryable);
    this.settingsButton.classList.toggle('ht-hidden', !this.state.showSettings);
    this.updateDragFeedback();
    this.updateResizeFeedback();

    this.status.dataset.tone = this.state.status === 'error' || this.state.status === 'partial'
      ? 'error'
      : 'neutral';
    if (this.state.status === 'streaming') {
      this.status.textContent = UI_TEXT.translating;
    } else if (this.state.status === 'partial') {
      this.status.textContent = `${UI_TEXT.incompleteTranslation} · ${this.state.errorMessage}`;
    } else {
      this.status.textContent = this.state.errorMessage;
    }

    this.schedulePosition();
  }

  private copyResult(): void {
    if (!canCopyResult(this.state)) {
      return;
    }

    void navigator.clipboard.writeText(this.state.text).then(() => {
      this.copyButton.textContent = UI_TEXT.copied;
      if (this.copyFeedbackTimer) {
        clearTimeout(this.copyFeedbackTimer);
      }
      this.copyFeedbackTimer = setTimeout(() => {
        this.copyButton.textContent = UI_TEXT.copy;
      }, 1_500);
    }).catch(() => {
      this.status.dataset.tone = 'error';
      this.status.textContent = UI_TEXT.copyFailed;
    });
  }

  private cancelActiveRequest(): void {
    if (!this.state.requestId || this.state.status !== 'streaming' || !this.port) {
      return;
    }

    const message: ClientPortMessage = { type: 'cancel', requestId: this.state.requestId };
    this.port.postMessage(message);
  }

  private close(cancel: boolean): void {
    if (cancel) {
      this.cancelActiveRequest();
    }
    this.resetPositionState();
    this.resetCardSizeState();
    this.trigger.classList.add('ht-hidden');
    this.card.classList.add('ht-hidden');
    this.activeSelection = null;
    this.state = createCardState();
  }

  private schedulePosition(): void {
    if (this.positionFrame !== null) {
      return;
    }

    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = null;
      this.position();
    });
  }

  private position(): void {
    if (!this.activeSelection) {
      return;
    }

    const cardHidden = this.card.classList.contains('ht-hidden');
    const overlay = cardHidden ? this.trigger : this.card;

    if (!cardHidden) {
      this.applyUserCardSize();
    }

    if (cardHidden || this.positionState.position.kind === 'anchored') {
      let rect: DOMRect;
      try {
        rect = getRangeEndpointRect(this.activeSelection.range);
      } catch {
        return;
      }

      const size = cardHidden
        ? { width: 42, height: 42 }
        : this.cardSize();
      const anchored = placeOverlay(rect, size, this.viewportSize(), 8);

      overlay.style.left = `${anchored.x}px`;
      overlay.style.top = `${anchored.y}px`;
      overlay.style.visibility = anchored.visible ? 'visible' : 'hidden';
      return;
    }

    this.positionState = reduceCardPosition(this.positionState, {
      type: 'layout-changed',
      cardSize: this.cardSize(),
      viewport: this.viewportSize(),
    });
    const free = this.positionState.position;
    if (free.kind === 'free') {
      overlay.style.left = `${free.x}px`;
      overlay.style.top = `${free.y}px`;
      overlay.style.visibility = 'visible';
    }
  }

  private applyUserCardSize(): void {
    const resolved = resolveUserCardSize(this.sizeState, this.viewportSize());
    if (!resolved) {
      this.card.style.removeProperty('width');
      this.card.style.removeProperty('height');
      this.card.removeAttribute('data-size-mode');
      return;
    }

    this.card.dataset.sizeMode = 'user';
    const width = `${resolved.width}px`;
    const height = `${resolved.height}px`;
    if (this.card.style.width !== width) {
      this.card.style.width = width;
    }
    if (this.card.style.height !== height) {
      this.card.style.height = height;
    }
  }
}

export function mountHighlightTranslateUi(): HighlightTranslateUi | null {
  return window.top === window ? new HighlightTranslateUi() : null;
}

if (window.top === window) {
  mountHighlightTranslateUi();
}
