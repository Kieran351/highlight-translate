import { ApiKeyStore } from './api-key-store';
import { DeepSeekProvider } from './deepseek-provider';
import { createLanguageRouter } from './language-router';
import { createSettingsMessageHandler } from './settings-handler';
import { createTranslationSession } from './translation-session';
import type { PortLike } from './translation-session';
import type { ExtensionMessage, ExtensionResponse } from '../shared/messages';
import { PORT_NAME } from '../shared/constants';

const apiKeyStore = new ApiKeyStore(chrome.storage.local);
const provider = new DeepSeekProvider();
const detectLanguage = createLanguageRouter((text) => chrome.i18n.detectLanguage(text));

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

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
    getApiKey: () => apiKeyStore.get(),
    streamTranslation: (input) => provider.stream(input),
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
  store: apiKeyStore,
  provider,
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
