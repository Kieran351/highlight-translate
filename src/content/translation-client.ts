import { MAX_SELECTION_LENGTH, PORT_NAME } from '../shared/constants';
import { getErrorPresentation } from '../shared/errors';
import type { ClientPortMessage, ServerPortMessage } from '../shared/messages';
import type { CardStatus, RequestActivity } from './card-state';
import {
  applyServerMessage,
  beginRequest,
  beginRetry,
  canCopyResult,
  createCardState,
  getRequestActivity,
} from './card-state';
import { UI_TEXT } from '../shared/ui-text';

export interface ClientPort {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: ClientPortMessage): void;
}

export interface TranslationClientDependencies {
  connect(): ClientPort | null;
  createRequestId(): string;
}

export interface TranslationView {
  direction: string;
  text: string;
  status: CardStatus;
  errorMessage: string;
  retryable: boolean;
  showSettings: boolean;
  canCopy: boolean;
  activity: RequestActivity;
}

export interface TranslationClient {
  translate(text: string): void;
  retry(): void;
  cancel(): void;
  view(): TranslationView;
  subscribe(listener: (view: TranslationView) => void): () => void;
  dispose(): void;
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

export function connectExtensionPort(): ClientPort | null {
  try {
    if (typeof chrome === 'undefined' || typeof chrome.runtime?.connect !== 'function') {
      return null;
    }
    return chrome.runtime.connect({ name: PORT_NAME });
  } catch {
    return null;
  }
}

export function createTranslationClient(dependencies: TranslationClientDependencies): TranslationClient {
  let state = createCardState();
  let currentPort: ClientPort | null = null;
  let inputText: string | null = null;
  let disposed = false;
  const listeners = new Set<(view: TranslationView) => void>();

  function view(): TranslationView {
    return {
      direction: state.direction,
      text: state.text,
      status: state.status,
      errorMessage: state.errorMessage,
      retryable: state.retryable,
      showSettings: state.showSettings,
      canCopy: canCopyResult(state),
      activity: getRequestActivity(state),
    };
  }

  function notify(): void {
    if (disposed) {
      return;
    }
    const currentView = view();
    for (const listener of [...listeners]) {
      listener(currentView);
    }
  }

  function update(next: typeof state): void {
    if (next === state) {
      return;
    }
    state = next;
    notify();
  }

  function onServerMessage(message: unknown): void {
    if (disposed || !isServerMessage(message) || message.requestId !== state.requestId) {
      return;
    }
    update(applyServerMessage(state, message));
  }

  function onPortDisconnect(port: ClientPort): void {
    if (currentPort !== port) {
      return;
    }
    currentPort = null;
    if (state.status !== 'streaming' || !state.requestId) {
      return;
    }

    const presentation = getErrorPresentation('network');
    onServerMessage({
      type: 'error',
      requestId: state.requestId,
      code: 'network',
      message: presentation.message,
      retryable: true,
      partial: state.text.length > 0,
    });
  }

  function ensurePort(): ClientPort | null {
    if (currentPort) {
      return currentPort;
    }

    try {
      const port = dependencies.connect();
      if (!port) {
        return null;
      }
      port.onMessage.addListener(onServerMessage);
      port.onDisconnect.addListener(() => onPortDisconnect(port));
      currentPort = port;
      return port;
    } catch {
      currentPort = null;
      return null;
    }
  }

  function postPortMessage(port: ClientPort, message: ClientPortMessage): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch {
      if (currentPort === port) {
        currentPort = null;
      }
      return false;
    }
  }

  function failInvalidExtensionContext(requestId: string): void {
    update(applyServerMessage(state, {
      type: 'error',
      requestId,
      code: 'network',
      message: UI_TEXT.extensionContextInvalid,
      retryable: false,
      partial: state.text.length > 0,
    }));
  }

  function cancelActiveRequest(): void {
    if (state.status !== 'streaming' || !state.requestId || !currentPort) {
      return;
    }
    postPortMessage(currentPort, { type: 'cancel', requestId: state.requestId });
  }

  function sendTranslation(text: string, retry: boolean): void {
    if (disposed) {
      return;
    }

    cancelActiveRequest();
    const requestId = dependencies.createRequestId();
    update(retry ? beginRetry(state, requestId) : beginRequest(state, requestId));
    const port = ensurePort();
    if (!port || !postPortMessage(port, { type: 'translate', requestId, text })) {
      failInvalidExtensionContext(requestId);
    }
  }

  return {
    translate(text) {
      if (disposed) {
        return;
      }
      if (text.length > MAX_SELECTION_LENGTH) {
        cancelActiveRequest();
        inputText = null;
        const presentation = getErrorPresentation('too_long');
        update({
          ...createCardState(),
          direction: UI_TEXT.unableToTranslate,
          status: 'error',
          errorMessage: presentation.message,
        });
        return;
      }
      inputText = text;
      sendTranslation(text, false);
    },
    retry() {
      if (!disposed && state.retryable && inputText !== null) {
        sendTranslation(inputText, true);
      }
    },
    cancel() {
      if (disposed) {
        return;
      }
      cancelActiveRequest();
      inputText = null;
      update(createCardState());
    },
    view,
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) {
        return;
      }
      cancelActiveRequest();
      disposed = true;
      listeners.clear();
      currentPort = null;
      inputText = null;
    },
  };
}
