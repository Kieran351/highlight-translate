import styles from './content.css?inline';

import {
  applyServerMessage,
  beginRequest,
  beginRetry,
  canCopyResult,
  createCardState,
} from './card-state';
import type { CardState } from './card-state';
import { endpointFromSelection, getRangeEndpointRect, placeOverlay } from './geometry';
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

class HighlightTranslateUi {
  private readonly host = document.createElement('div');
  private readonly shadow: ShadowRoot;
  private readonly trigger = element('button', 'ht-trigger ht-hidden', UI_TEXT.trigger);
  private readonly card = element('section', 'ht-card ht-hidden');
  private readonly direction = element('span', 'ht-direction', UI_TEXT.detectingLanguage);
  private readonly result = element('div', 'ht-result');
  private readonly status = element('div', 'ht-status');
  private readonly retryButton = element('button', 'ht-button', UI_TEXT.retry);
  private readonly settingsButton = element('button', 'ht-button', UI_TEXT.openSettings);
  private readonly copyButton = element('button', 'ht-button ht-button--primary', UI_TEXT.copy);
  private readonly closeButton = element('button', 'ht-close', '×');
  private activeSelection: ActiveSelection | null = null;
  private state: CardState = createCardState();
  private port: chrome.runtime.Port | null = null;
  private followOutput = true;
  private positionFrame: number | null = null;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.host.dataset.highlightTranslateRoot = '';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.shadow.append(style, this.trigger, this.card);
    document.documentElement.append(this.host);
    this.buildCard();
    this.bindEvents();
  }

  private buildCard(): void {
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', UI_TEXT.translationDialogLabel);

    const header = element('header', 'ht-header');
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', UI_TEXT.closeTranslationLabel);
    header.append(this.direction, this.closeButton);

    this.result.setAttribute('role', 'region');
    this.result.setAttribute('aria-live', 'polite');
    this.result.tabIndex = 0;

    this.status.setAttribute('role', 'status');
    const actions = element('footer', 'ht-actions');
    for (const button of [this.retryButton, this.settingsButton, this.copyButton]) {
      button.type = 'button';
    }
    this.retryButton.classList.add('ht-hidden');
    this.settingsButton.classList.add('ht-hidden');
    this.copyButton.disabled = true;
    actions.append(this.settingsButton, this.retryButton, this.copyButton);
    this.card.append(header, this.result, this.status, actions);
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
    window.addEventListener('scroll', () => this.schedulePosition(), true);
    window.addEventListener('resize', () => this.schedulePosition());
  }

  private onMouseUp(event: MouseEvent): void {
    if (event.button !== 0 || event.composedPath().includes(this.host)) {
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
    const requestId = crypto.randomUUID().replaceAll('-', '');
    this.state = retry
      ? beginRetry(this.state, requestId)
      : beginRequest(this.state, requestId);
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

    let rect: DOMRect;
    try {
      rect = getRangeEndpointRect(this.activeSelection.range);
    } catch {
      return;
    }

    const overlay = this.card.classList.contains('ht-hidden') ? this.trigger : this.card;
    const size = this.card.classList.contains('ht-hidden')
      ? { width: 42, height: 42 }
      : { width: this.card.offsetWidth, height: this.card.offsetHeight };
    const position = placeOverlay(rect, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, 8);

    overlay.style.left = `${position.x}px`;
    overlay.style.top = `${position.y}px`;
    overlay.style.visibility = position.visible ? 'visible' : 'hidden';
  }
}

if (window.top === window) {
  new HighlightTranslateUi();
}
