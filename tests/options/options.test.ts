// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { ApiKeyStore } from '../../src/background/api-key-store';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';
import { UI_TEXT } from '../../src/shared/ui-text';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('routes settings page load, save, test and clear through worker messages', async () => {
  const values: Record<string, unknown> = {};
  const store = new ApiKeyStore({
    get: async () => ({ ...values }),
    set: async (items) => { Object.assign(values, items); },
    remove: async (key) => { delete values[key]; },
  });
  await store.save('saved-fake-key');
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
  const handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', store, provider: new DeepSeekProvider(fetchImpl) });
  vi.stubGlobal('chrome', { runtime: { sendMessage: (message: unknown) => handle(message, sender) } });
  document.body.innerHTML = '<form id="settings-form"><input id="api-key" type="password"></form><button id="toggle-key"></button><button id="clear-key"></button><button id="test-key"></button><div id="settings-status"></div>';
  await import('../../src/options/options');
  const input = document.querySelector<HTMLInputElement>('#api-key')!;
  const status = document.querySelector('#settings-status')!;
  await vi.waitFor(() => expect(input.value).toBe('saved-fake-key'));
  input.value = ' new-fake-key ';
  document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(status.textContent).toBe(UI_TEXT.keySaved));
  expect(await store.get()).toBe('new-fake-key');
  expect(fetchImpl).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('#test-key')!.click();
  await vi.waitFor(() => expect(status.textContent).toBe(UI_TEXT.connectionSucceeded));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  document.querySelector<HTMLButtonElement>('#clear-key')!.click();
  await vi.waitFor(() => expect(status.textContent).toBe(UI_TEXT.keyCleared));
  expect(await store.get()).toBe('');
  expect(input.value).toBe('');
});
