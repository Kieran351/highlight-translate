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
import { createCardInteraction } from './card-interaction';
import type { CardInteraction, CardInteractionEnvironment } from './card-interaction';
import { endpointFromSelection } from './geometry';
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
  private readonly interaction: CardInteraction;
  private activeSelection: ActiveSelection | null = null;
  private state: CardState = createCardState();
  private port: chrome.runtime.Port | null = null;
  private followOutput = true;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private stage: 'idle' | 'trigger' | 'card' = 'idle';

  constructor(environment: Partial<CardInteractionEnvironment> = {}) {
    this.host.dataset.highlightTranslateRoot = '';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.shadow.append(style, this.trigger, this.card);
    document.documentElement.append(this.host);
    this.buildCard();
    this.bindEvents();
    this.interaction = createCardInteraction({
      host: this.host,
      trigger: this.trigger,
      card: this.card,
      header: this.header,
      closeButton: this.closeButton,
      resizeHandle: this.resizeHandle,
    }, environment);
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
      if (!event.composedPath().includes(this.host) && this.stage === 'card') {
        this.close(true);
      }
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.stage === 'card') {
        this.close(true);
      }
    }, true);
  }

  private onMouseUp(event: MouseEvent): void {
    if (this.interaction.consumeGestureMouseUp(event)) {
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
    this.activeSelection = {
      text: evaluation.text,
      range: endpointRange,
      tooLong: evaluation.kind === 'too-long',
    };
    this.state = createCardState();
    this.stage = 'trigger';
    this.interaction.setRequestActivity(getRequestActivity(this.state));
    this.interaction.showTrigger(endpointRange);
  }

  private openCard(): void {
    if (!this.activeSelection) {
      return;
    }

    this.stage = 'card';
    this.interaction.openCard();
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
      return;
    }

    this.startRequest(false);
  }

  private ensurePort(): chrome.runtime.Port | null {
    if (this.port) {
      return this.port;
    }

    try {
      if (typeof chrome === 'undefined' || typeof chrome.runtime?.connect !== 'function') {
        return null;
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
    } catch {
      this.port = null;
      return null;
    }
  }

  private failInvalidExtensionContext(requestId: string): void {
    this.onServerMessage({
      type: 'error',
      requestId,
      code: 'network',
      message: UI_TEXT.extensionContextInvalid,
      retryable: false,
      partial: this.state.text.length > 0,
    });
  }

  private postPortMessage(port: chrome.runtime.Port, message: ClientPortMessage): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch {
      if (this.port === port) {
        this.port = null;
      }
      return false;
    }
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
    const port = this.ensurePort();
    if (!port || !this.postPortMessage(port, message)) {
      this.failInvalidExtensionContext(requestId);
    }
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
    this.interaction.setRequestActivity(getRequestActivity(this.state));

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
    this.postPortMessage(this.port, message);
  }

  private close(cancel: boolean): void {
    if (cancel) {
      this.cancelActiveRequest();
    }
    this.activeSelection = null;
    this.state = createCardState();
    this.stage = 'idle';
    this.interaction.setRequestActivity(getRequestActivity(this.state));
    this.interaction.hide();
  }
}

export function mountHighlightTranslateUi(
  environment: Partial<CardInteractionEnvironment> = {},
): HighlightTranslateUi | null {
  return window.top === window ? new HighlightTranslateUi(environment) : null;
}
