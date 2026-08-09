import { MAX_SELECTION_LENGTH, TRANSLATION_TIMEOUTS } from '../shared/constants';
import { getErrorPresentation } from '../shared/errors';
import type { ClientPortMessage, ServerPortMessage } from '../shared/messages';
import type { AppErrorCode, LanguageRoute } from '../shared/types';
import { UI_TEXT } from '../shared/ui-text';
import { ProviderFailure } from './provider';
import type { StreamTranslationInput } from './provider';

interface ListenerTarget<T> {
  addListener(listener: (value: T) => void): void;
  removeListener(listener: (value: T) => void): void;
}

export interface PortLike {
  onMessage: ListenerTarget<unknown>;
  onDisconnect: ListenerTarget<void>;
  postMessage(message: ServerPortMessage): void;
}

export interface TranslationDependencies {
  detectLanguage(text: string): Promise<LanguageRoute>;
  getApiKey(): Promise<string>;
  streamTranslation(input: StreamTranslationInput): Promise<void>;
  timeouts?: {
    firstContentMs: number;
    idleMs: number;
    totalMs: number;
  };
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTranslateMessage(message: unknown): message is Extract<ClientPortMessage, { type: 'translate' }> {
  return isRecord(message)
    && message.type === 'translate'
    && typeof message.requestId === 'string'
    && REQUEST_ID_PATTERN.test(message.requestId)
    && typeof message.text === 'string';
}

function isCancelMessage(message: unknown): message is Extract<ClientPortMessage, { type: 'cancel' }> {
  return isRecord(message)
    && message.type === 'cancel'
    && typeof message.requestId === 'string'
    && REQUEST_ID_PATTERN.test(message.requestId);
}

function postError(
  port: PortLike,
  requestId: string,
  code: AppErrorCode,
  partial: boolean,
): void {
  const presentation = getErrorPresentation(code);
  port.postMessage({
    type: 'error',
    requestId,
    code,
    message: presentation.message,
    retryable: presentation.retryable,
    partial,
    ...(presentation.showSettings ? { showSettings: true } : {}),
  });
}

function directionFor(route: LanguageRoute): string {
  if (route.kind === 'chinese') {
    return UI_TEXT.chinese;
  }

  return `${route.label} → ${UI_TEXT.targetLanguage}`;
}

async function runTranslation(
  port: PortLike,
  request: Extract<ClientPortMessage, { type: 'translate' }>,
  dependencies: TranslationDependencies,
  controller: AbortController,
): Promise<void> {
  const { requestId, text } = request;

  if (text.length === 0) {
    postError(port, requestId, 'invalid_request', false);
    return;
  }

  if (text.length > MAX_SELECTION_LENGTH) {
    postError(port, requestId, 'too_long', false);
    return;
  }

  const route = await dependencies.detectLanguage(text);
  if (controller.signal.aborted) {
    return;
  }

  port.postMessage({
    type: 'route',
    requestId,
    direction: directionFor(route),
    local: route.kind === 'chinese',
  });

  if (route.kind === 'chinese') {
    port.postMessage({ type: 'chunk', requestId, text });
    port.postMessage({ type: 'complete', requestId });
    return;
  }

  const apiKey = (await dependencies.getApiKey()).trim();
  if (controller.signal.aborted) {
    return;
  }

  if (!apiKey) {
    postError(port, requestId, 'missing_key', false);
    return;
  }

  const timeouts = dependencies.timeouts ?? TRANSLATION_TIMEOUTS;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutCode: Extract<AppErrorCode, 'timeout_first' | 'timeout_idle' | 'timeout_total'> | undefined;
  let hasContent = false;

  const abortForTimeout = (code: typeof timeoutCode): void => {
    timeoutCode = code;
    controller.abort();
  };

  firstTimer = setTimeout(() => abortForTimeout('timeout_first'), timeouts.firstContentMs);
  const totalTimer = setTimeout(() => abortForTimeout('timeout_total'), timeouts.totalMs);

  const clearTimers = (): void => {
    if (firstTimer !== undefined) clearTimeout(firstTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };

  try {
    await dependencies.streamTranslation({
      apiKey,
      text,
      signal: controller.signal,
      onChunk: (chunk) => {
        if (!chunk || controller.signal.aborted) {
          return;
        }

        hasContent = true;
        if (firstTimer !== undefined) {
          clearTimeout(firstTimer);
          firstTimer = undefined;
        }
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => abortForTimeout('timeout_idle'), timeouts.idleMs);
        port.postMessage({ type: 'chunk', requestId, text: chunk });
      },
    });

    if (timeoutCode) {
      postError(port, requestId, timeoutCode, hasContent);
      return;
    }

    if (controller.signal.aborted) {
      return;
    }

    if (!hasContent) {
      postError(port, requestId, 'empty_response', false);
      return;
    }

    port.postMessage({ type: 'complete', requestId });
  } catch (error) {
    if (timeoutCode) {
      postError(port, requestId, timeoutCode, hasContent);
    } else if (!controller.signal.aborted) {
      const code = error instanceof ProviderFailure ? error.code : 'network';
      postError(port, requestId, code, hasContent);
    }
  } finally {
    clearTimers();
  }
}

export function createTranslationSession(
  port: PortLike,
  dependencies: TranslationDependencies,
): () => void {
  const activeRequests = new Map<string, AbortController>();

  const onMessage = (message: unknown): void => {
    if (isCancelMessage(message)) {
      const active = activeRequests.get(message.requestId);
      if (active) {
        active.abort();
        activeRequests.delete(message.requestId);
        port.postMessage({ type: 'cancelled', requestId: message.requestId });
      }
      return;
    }

    if (!isTranslateMessage(message)) {
      postError(port, 'invalid', 'invalid_request', false);
      return;
    }

    activeRequests.get(message.requestId)?.abort();
    const controller = new AbortController();
    activeRequests.set(message.requestId, controller);

    void runTranslation(port, message, dependencies, controller).finally(() => {
      if (activeRequests.get(message.requestId) === controller) {
        activeRequests.delete(message.requestId);
      }
    });
  };

  const onDisconnect = (): void => {
    for (const controller of activeRequests.values()) {
      controller.abort();
    }
    activeRequests.clear();
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);

  return () => {
    onDisconnect();
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
  };
}
