import { createTranslationSession } from '../../src/background/translation-session';
import type { PortLike, TranslationDependencies } from '../../src/background/translation-session';
import type { ClientPort } from '../../src/content/translation-client';
import type { ClientPortMessage, ServerPortMessage } from '../../src/shared/messages';
import { FakePort } from './fake-port';

class ListenerHub<T> {
  private readonly listeners = new Set<(value: T) => void>();

  addListener = (listener: (value: T) => void): void => {
    this.listeners.add(listener);
  };

  emit(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

export interface SessionConnection {
  fakePort: FakePort;
  clientMessages: ClientPortMessage[];
  sendToClient(message: ServerPortMessage): void;
  sendRawToClient(message: unknown): void;
  disconnect(): void;
}

export interface SessionBridge {
  connect(): ClientPort;
  connections: SessionConnection[];
}

export function createSessionBridge(
  overrides: Partial<TranslationDependencies> = {},
): SessionBridge {
  const connections: SessionConnection[] = [];
  const dependencies: TranslationDependencies = {
    detectLanguage: async () => ({ kind: 'unknown', label: '自动检测' }),
    getRequestConfiguration: async () => ({
      providerId: 'deepseek',
      apiKey: 'session-bridge-key',
      modelId: 'session-bridge-model',
    }),
    streamTranslation: async ({ onChunk }) => onChunk('译文'),
    ...overrides,
  };

  function connect(): ClientPort {
    const fakePort = new FakePort();
    const clientMessages: ClientPortMessage[] = [];
    const clientMessagesHub = new ListenerHub<unknown>();
    const clientDisconnectHub = new ListenerHub<void>();
    const serverPort: PortLike = {
      onMessage: fakePort.onMessage,
      onDisconnect: fakePort.onDisconnect,
      postMessage(message) {
        fakePort.postMessage(message);
        queueMicrotask(() => clientMessagesHub.emit(message));
      },
    };
    const clientPort: ClientPort = {
      onMessage: { addListener: (listener) => clientMessagesHub.addListener(listener) },
      onDisconnect: { addListener: (listener) => clientDisconnectHub.addListener(listener) },
      postMessage(message) {
        clientMessages.push(message);
        queueMicrotask(() => fakePort.onMessage.emit(message));
      },
    };

    createTranslationSession(serverPort, dependencies);
    connections.push({
      fakePort,
      clientMessages,
      sendToClient: (message) => serverPort.postMessage(message),
      sendRawToClient: (message) => queueMicrotask(() => clientMessagesHub.emit(message)),
      disconnect() {
        queueMicrotask(() => {
          clientDisconnectHub.emit();
          fakePort.onDisconnect.emit();
        });
      },
    });
    return clientPort;
  }

  return { connect, connections };
}
