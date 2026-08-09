import './options.css';

import { ApiKeyStore } from '../background/api-key-store';
import type { ExtensionMessage, ExtensionResponse } from '../shared/messages';
import { UI_TEXT } from '../shared/ui-text';
import type { UiTextKey } from '../shared/ui-text';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing options element: ${selector}`);
  }
  return element;
}

function applyStaticText(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-ui-text]')) {
    const key = node.dataset.uiText as UiTextKey;
    node.textContent = UI_TEXT[key];
  }

  for (const input of document.querySelectorAll<HTMLInputElement>('[data-ui-placeholder]')) {
    const key = input.dataset.uiPlaceholder as UiTextKey;
    input.placeholder = UI_TEXT[key];
  }
}

applyStaticText();

const form = requireElement<HTMLFormElement>('#settings-form');
const apiKeyInput = requireElement<HTMLInputElement>('#api-key');
const toggleButton = requireElement<HTMLButtonElement>('#toggle-key');
const clearButton = requireElement<HTMLButtonElement>('#clear-key');
const testButton = requireElement<HTMLButtonElement>('#test-key');
const status = requireElement<HTMLElement>('#settings-status');
const store = new ApiKeyStore(chrome.storage.local);

function setStatus(message: string, tone: 'success' | 'error' | 'neutral' = 'neutral'): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

async function initialize(): Promise<void> {
  apiKeyInput.value = await store.get();
  if (apiKeyInput.value) {
    setStatus(UI_TEXT.keyLoaded);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void store.save(apiKeyInput.value).then(() => {
    apiKeyInput.value = apiKeyInput.value.trim();
    setStatus(apiKeyInput.value ? UI_TEXT.keySaved : UI_TEXT.keyCleared, 'success');
  }).catch(() => {
    setStatus(UI_TEXT.keySaveFailed, 'error');
  });
});

clearButton.addEventListener('click', () => {
  void store.clear().then(() => {
    apiKeyInput.value = '';
    setStatus(UI_TEXT.keyCleared, 'success');
  }).catch(() => {
    setStatus(UI_TEXT.keyClearFailed, 'error');
  });
});

toggleButton.addEventListener('click', () => {
  const shouldShow = apiKeyInput.type === 'password';
  apiKeyInput.type = shouldShow ? 'text' : 'password';
  toggleButton.textContent = shouldShow ? UI_TEXT.hide : UI_TEXT.show;
});

testButton.addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus(UI_TEXT.enterKeyBeforeTest, 'error');
    return;
  }

  testButton.disabled = true;
  setStatus(UI_TEXT.testingConnection);
  const message: ExtensionMessage = { type: 'test-connection', apiKey };

  void chrome.runtime.sendMessage<ExtensionMessage, ExtensionResponse>(message)
    .then((response) => {
      if (response?.ok) {
        setStatus(UI_TEXT.connectionSucceeded, 'success');
      } else {
        setStatus(response?.message ?? UI_TEXT.connectionFailed, 'error');
      }
    })
    .catch(() => {
      setStatus(UI_TEXT.connectionFailed, 'error');
    })
    .finally(() => {
      testButton.disabled = false;
    });
});

void initialize().catch(() => {
  setStatus(UI_TEXT.settingsReadFailed, 'error');
});
