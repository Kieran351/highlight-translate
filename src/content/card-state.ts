import type { ServerPortMessage } from '../shared/messages';
import { UI_TEXT } from '../shared/ui-text';

export type CardStatus = 'idle' | 'streaming' | 'complete' | 'partial' | 'error';

export interface CardState {
  requestId: string | null;
  direction: string;
  text: string;
  status: CardStatus;
  errorMessage: string;
  retryable: boolean;
  showSettings: boolean;
  replaceOnNextChunk: boolean;
}

export function createCardState(): CardState {
  return {
    requestId: null,
    direction: UI_TEXT.detectingLanguage,
    text: '',
    status: 'idle',
    errorMessage: '',
    retryable: false,
    showSettings: false,
    replaceOnNextChunk: false,
  };
}

export function beginRequest(state: CardState, requestId: string): CardState {
  return {
    ...state,
    requestId,
    direction: UI_TEXT.detectingLanguage,
    text: '',
    status: 'streaming',
    errorMessage: '',
    retryable: false,
    showSettings: false,
    replaceOnNextChunk: false,
  };
}

export function beginRetry(state: CardState, requestId: string): CardState {
  return {
    ...state,
    requestId,
    status: 'streaming',
    errorMessage: '',
    retryable: false,
    showSettings: false,
    replaceOnNextChunk: state.text.length > 0,
  };
}

export function applyServerMessage(state: CardState, message: ServerPortMessage): CardState {
  if (message.requestId !== state.requestId) {
    return state;
  }

  switch (message.type) {
    case 'route':
      return { ...state, direction: message.direction };
    case 'chunk':
      return {
        ...state,
        text: state.replaceOnNextChunk ? message.text : state.text + message.text,
        replaceOnNextChunk: false,
      };
    case 'complete':
      return {
        ...state,
        status: 'complete',
        errorMessage: '',
        retryable: false,
        showSettings: false,
        replaceOnNextChunk: false,
      };
    case 'error':
      return {
        ...state,
        status: state.text && (message.partial || state.replaceOnNextChunk) ? 'partial' : 'error',
        errorMessage: message.message,
        retryable: message.retryable,
        showSettings: message.showSettings ?? false,
        replaceOnNextChunk: false,
      };
    case 'cancelled':
      return state;
  }
}

export function canCopyResult(state: CardState): boolean {
  return state.text.length > 0 && (state.status === 'complete' || state.status === 'partial');
}
