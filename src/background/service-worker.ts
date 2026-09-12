import { ConfigurationStore } from './configuration-store';
import { ConfigurationManager } from './configuration-manager';
import { resolveProvider } from './provider-registry';
import { ProviderFailure } from './provider';
import { createLanguageRouter } from './language-router';
import { createSettingsMessageHandler } from './settings-handler';
import { createTranslationSession } from './translation-session';
import type { PortLike } from './translation-session';
import type { ExtensionMessage, ExtensionResponse } from '../shared/messages';
import { PORT_NAME } from '../shared/constants';

const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .then(() => true, () => false);
async function requireTrustedStorage(): Promise<void> {
  if (!await storageReady) throw new Error('Trusted storage unavailable');
}
const manager = new ConfigurationManager({
  store: new ConfigurationStore({
    get: async (key) => { await requireTrustedStorage(); return chrome.storage.local.get(key); },
    set: async (items) => { await requireTrustedStorage(); await chrome.storage.local.set(items); },
    remove: async (key) => { await requireTrustedStorage(); await chrome.storage.local.remove(key); },
  }),
  resolveProvider,
});
const detectLanguage = createLanguageRouter((text) => chrome.i18n.detectLanguage(text));


chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

function isTrustedTopLevelPage(port: chrome.runtime.Port): boolean {
  const sender = port.sender;
  if (port.name !== PORT_NAME || sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id) {
    return false;
  }

  try {
    const url = new URL(sender.url ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!isTrustedTopLevelPage(port)) {
    port.disconnect();
    return;
  }

  createTranslationSession(port as unknown as PortLike, {
    detectLanguage,
    getRequestConfiguration: () => manager.requestConfiguration(),
    streamTranslation: (input) => {
      if (!input.providerId) throw new ProviderFailure('invalid_configuration');
      return resolveProvider(input.providerId).stream(input);
    },
  });
});

function isContentPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id) {
    return false;
  }

  try {
    const url = new URL(sender.url ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const handleSettingsMessage = createSettingsMessageHandler({
  extensionId: chrome.runtime.id,
  extensionUrl: chrome.runtime.getURL(''),
  manager,
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false;
  }

  const typedMessage = message as ExtensionMessage;
  if (typedMessage.type === 'open-options') {
    if (!isContentPageSender(sender)) {
      return false;
    }
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true } satisfies ExtensionResponse);
    return false;
  }

  void handleSettingsMessage(message, sender).then(sendResponse);
  return true;
});
