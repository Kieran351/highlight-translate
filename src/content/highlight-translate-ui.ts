import styles from './content.css?inline';

import { createCardInteraction } from './card-interaction';
import type { CardInteraction, CardInteractionEnvironment } from './card-interaction';
import { connectExtensionPort, createTranslationClient } from './translation-client';
import type { TranslationClient, TranslationClientDependencies, TranslationView } from './translation-client';
import { endpointFromSelection } from './geometry';
import { evaluateSelection, isEditableNode } from './selection-policy';
import type { ExtensionMessage } from '../shared/messages';
import { UI_TEXT } from '../shared/ui-text';

interface ActiveSelection {
  text: string;
  range: Range;
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

export interface HighlightTranslateUiOptions {
  shadowMode?: ShadowRootMode;
  environment?: Partial<CardInteractionEnvironment>;
  connect?: TranslationClientDependencies['connect'];
  createRequestId?: TranslationClientDependencies['createRequestId'];
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
  private readonly translationClient: TranslationClient;
  private activeSelection: ActiveSelection | null = null;
  private followOutput = true;
  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private stage: 'idle' | 'trigger' | 'card' = 'idle';
  private disposed = false;
  private readonly documentMouseUpListener = (event: MouseEvent): void => this.onMouseUp(event);
  private readonly documentPointerDownListener = (event: PointerEvent): void => {
    if (!event.composedPath().includes(this.host) && this.stage === 'card') {
      this.close();
    }
  };
  private readonly documentKeyDownListener = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.stage === 'card') {
      this.close();
    }
  };

  constructor(options: HighlightTranslateUiOptions = {}) {
    this.host.dataset.highlightTranslateRoot = '';
    this.shadow = this.host.attachShadow({ mode: options.shadowMode ?? 'closed' });
    const style = document.createElement('style');
    style.textContent = styles;
    this.shadow.append(style, this.trigger, this.card);
    document.documentElement.append(this.host);
    this.buildCard();
    this.interaction = createCardInteraction({
      host: this.host,
      trigger: this.trigger,
      card: this.card,
      header: this.header,
      closeButton: this.closeButton,
      resizeHandle: this.resizeHandle,
    }, options.environment);
    this.translationClient = createTranslationClient({
      connect: options.connect ?? connectExtensionPort,
      createRequestId: options.createRequestId ?? (() => crypto.randomUUID().replaceAll('-', '')),
    });
    this.translationClient.subscribe((view) => this.render(view));
    this.render(this.translationClient.view());
    this.bindEvents();
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
    this.closeButton.addEventListener('click', () => this.close());
    this.retryButton.addEventListener('click', () => this.translationClient.retry());
    this.settingsButton.addEventListener('click', () => {
      const message: ExtensionMessage = { type: 'open-options' };
      void chrome.runtime.sendMessage(message);
    });
    this.copyButton.addEventListener('click', () => this.copyResult());
    this.result.addEventListener('scroll', () => {
      const distanceFromBottom = this.result.scrollHeight - this.result.scrollTop - this.result.clientHeight;
      this.followOutput = distanceFromBottom <= 12;
    });

    document.addEventListener('mouseup', this.documentMouseUpListener, true);
    document.addEventListener('pointerdown', this.documentPointerDownListener, true);
    document.addEventListener('keydown', this.documentKeyDownListener, true);
  }

  private onMouseUp(event: MouseEvent): void {
    if (this.disposed) {
      return;
    }
    if (this.interaction.consumeGestureMouseUp(event)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }

    queueMicrotask(() => this.captureSelection(event.target));
  }

  private captureSelection(eventTarget: EventTarget | null): void {
    if (this.disposed) {
      return;
    }
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
      this.close();
      return;
    }

    const evaluation = evaluateSelection(selection.toString());
    const endpoint = endpointFromSelection(selection);
    if (evaluation.kind === 'invalid' || !endpoint) {
      this.close();
      return;
    }

    const endpointRange = selection.getRangeAt(0).cloneRange();
    endpointRange.setStart(endpoint.node, endpoint.offset);
    endpointRange.collapse(true);

    this.translationClient.cancel();
    this.activeSelection = {
      text: evaluation.text,
      range: endpointRange,
    };
    this.stage = 'trigger';
    this.interaction.showTrigger(endpointRange);
  }

  private openCard(): void {
    if (this.disposed || !this.activeSelection) {
      return;
    }

    this.stage = 'card';
    this.interaction.openCard();
    this.followOutput = true;
    this.translationClient.translate(this.activeSelection.text);
  }

  private render(view: TranslationView): void {
    const shouldFollow = this.followOutput;
    const previousText = this.result.textContent ?? '';
    this.direction.textContent = view.direction;
    this.result.textContent = view.text;
    this.copyButton.disabled = !view.canCopy;
    this.retryButton.classList.toggle('ht-hidden', !view.retryable);
    this.settingsButton.classList.toggle('ht-hidden', !view.showSettings);
    this.interaction.setRequestActivity(view.activity);

    this.status.dataset.tone = view.status === 'error' || view.status === 'partial'
      ? 'error'
      : 'neutral';
    if (view.status === 'streaming') {
      this.status.textContent = UI_TEXT.translating;
    } else if (view.status === 'partial') {
      this.status.textContent = `${UI_TEXT.incompleteTranslation} · ${view.errorMessage}`;
    } else {
      this.status.textContent = view.errorMessage;
    }

    if (view.text !== previousText && shouldFollow) {
      this.result.scrollTop = this.result.scrollHeight;
      this.followOutput = true;
    }
  }

  private copyResult(): void {
    const view = this.translationClient.view();
    if (!view.canCopy) {
      return;
    }

    void navigator.clipboard.writeText(view.text).then(() => {
      if (this.disposed) {
        return;
      }
      this.copyButton.textContent = UI_TEXT.copied;
      if (this.copyFeedbackTimer) {
        clearTimeout(this.copyFeedbackTimer);
      }
      this.copyFeedbackTimer = setTimeout(() => {
        this.copyButton.textContent = UI_TEXT.copy;
      }, 1_500);
    }).catch(() => {
      if (this.disposed) {
        return;
      }
      this.status.dataset.tone = 'error';
      this.status.textContent = UI_TEXT.copyFailed;
    });
  }

  private close(): void {
    if (this.disposed) {
      return;
    }
    this.translationClient.cancel();
    this.activeSelection = null;
    this.stage = 'idle';
    this.interaction.hide();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    document.removeEventListener('mouseup', this.documentMouseUpListener, true);
    document.removeEventListener('pointerdown', this.documentPointerDownListener, true);
    document.removeEventListener('keydown', this.documentKeyDownListener, true);
    if (this.copyFeedbackTimer) {
      clearTimeout(this.copyFeedbackTimer);
      this.copyFeedbackTimer = null;
    }
    this.translationClient.dispose();
    this.interaction.dispose();
    this.host.remove();
  }
}

export function mountHighlightTranslateUi(options: HighlightTranslateUiOptions = {}): HighlightTranslateUi | null {
  return window.top === window ? new HighlightTranslateUi(options) : null;
}
