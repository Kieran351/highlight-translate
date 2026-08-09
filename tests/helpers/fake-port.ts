import type { PortLike } from '../../src/background/translation-session';
import type { ServerPortMessage } from '../../src/shared/messages';

class ListenerHub<T> {
  private readonly listeners = new Set<(value: T) => void>();

  addListener = (listener: (value: T) => void): void => {
    this.listeners.add(listener);
  };

  removeListener = (listener: (value: T) => void): void => {
    this.listeners.delete(listener);
  };

  emit(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

export class FakePort implements PortLike {
  readonly onMessage = new ListenerHub<unknown>();
  readonly onDisconnect = new ListenerHub<void>();
  readonly messages: ServerPortMessage[] = [];

  postMessage = (message: ServerPortMessage): void => {
    this.messages.push(message);
  };
}
