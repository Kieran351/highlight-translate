import { ApiKeyStore } from './api-key-store';
import { DeepSeekProvider } from './deepseek-provider';
import { createLanguageRouter } from './language-router';
import { ProviderFailure } from './provider';
import { createTranslationSession } from './translation-session';
import type { PortLike } from './translation-session';
import { getErrorPresentation } from '../shared/errors';
import type { ExtensionMessage, ExtensionResponse } from '../shared/messages';
import { PORT_NAME } from '../shared/constants';
import { UI_TEXT } from '../shared/ui-text';

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

function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id
    && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}

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

  if (typedMessage.type !== 'test-connection' || !isExtensionPageSender(sender)) {
    return false;
  }

  if (typeof typedMessage.apiKey !== 'string' || !typedMessage.apiKey.trim()) {
    sendResponse({ ok: false, message: UI_TEXT.enterKeyBeforeTest } satisfies ExtensionResponse);
    return false;
  }

  void provider.testConnection(typedMessage.apiKey.trim())
    .then(() => sendResponse({ ok: true } satisfies ExtensionResponse))
    .catch((error: unknown) => {
      const code = error instanceof ProviderFailure ? error.code : 'network';
      sendResponse({
        ok: false,
        message: getErrorPresentation(code).message,
      } satisfies ExtensionResponse);
    });

  return true;
});
