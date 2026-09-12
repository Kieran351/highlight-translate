// @vitest-environment happy-dom
import optionsHtml from '../../options.html?raw';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import type { SettingsSnapshot } from '../../src/shared/types';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function setup(legacy = '', initialSettings?: SettingsSnapshot) {
  const values: Record<string, unknown> = { deepseekApiKey: legacy };
  const storage = {
    get: async () => structuredClone(values),
    set: async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); },
    remove: async (key: string) => { delete values[key]; },
  };
  const store = new ConfigurationStore(storage);
  if (initialSettings) await store.update((snapshot) => { Object.assign(snapshot, initialSettings); });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response('data: {"choices":[{"delta":{"content":"测试译文"}}]}\n\ndata: [DONE]\n\n')
    : Response.json({ data: [{ id: 'future-model' }, { id: '<img src=x onerror=alert(1)>' }] }));
  const manager = new ConfigurationManager({ store, resolveProvider: () => new DeepSeekProvider(fetchImpl) });
  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
  let handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', manager });
  vi.stubGlobal('chrome', { runtime: { sendMessage: (message: unknown) => handle(message, sender) } });
  document.documentElement.innerHTML = optionsHtml;
  await import('../../src/options/options');
  await vi.waitFor(() => expect(document.querySelector('#active-provider')?.textContent).toBeTruthy());
  const restart = () => {
    handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/',
      manager: new ConfigurationManager({ store: new ConfigurationStore(storage), resolveProvider: () => new DeepSeekProvider(fetchImpl) }) });
  };
  return { store, fetchImpl, manager, storage, restart };
}
function input<T extends HTMLElement>(id: string): T { return document.querySelector<T>(`#${id}`)!; }
function changeKey(value: string): void {
  input<HTMLInputElement>('api-key').value = value;
  input('api-key').dispatchEvent(new Event('input'));
  input('api-key').dispatchEvent(new Event('change'));
}
function selectModel(value: string): void {
  input<HTMLSelectElement>('model').value = value;
  input('model').dispatchEvent(new Event('change'));
}
function submit(): void { input('settings-form').dispatchEvent(new Event('submit', { cancelable: true })); }

it('automatically loads legacy key models and saves without testing through the real worker seam', async () => {
  const { store, fetchImpl } = await setup('legacy-fake-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  expect(input<HTMLInputElement>('api-key').value).toBe('legacy-fake-key');
  expect(input<HTMLSelectElement>('model').value).toBe('');
  expect(document.querySelector('img')).toBeNull();
  selectModel('future-model');
  submit();
  await vi.waitFor(() => expect(input('settings-status').textContent).toContain('配置已保存并启用'));
  expect((await store.read()).configurations.deepseek?.selectedModelId).toBe('future-model');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  input<HTMLButtonElement>('clear-key').click();
  await vi.waitFor(() => expect(input<HTMLInputElement>('api-key').value).toBe(''));
  expect((await store.read()).configurations.deepseek).toBeUndefined();
});

it('fetches changed credentials without manual refresh and ignores a late old-key catalog', async () => {
  const { fetchImpl } = await setup();
  let resolveOld!: (response: Response) => void;
  fetchImpl.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  changeKey('old-fake-key');
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  changeKey('new-fake-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  resolveOld(Response.json({ data: [{ id: 'stale-model' }] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(input<HTMLInputElement>('api-key').value).toBe('new-fake-key');
  expect(input('model').textContent).not.toContain('stale-model');
});

it('still automatically fetches when trailing whitespace is entered before the debounce completes', async () => {
  const { fetchImpl } = await setup();
  input<HTMLInputElement>('api-key').value = 'synthetic-key';
  input('api-key').dispatchEvent(new Event('input'));
  input<HTMLInputElement>('api-key').value = 'synthetic-key ';
  input('api-key').dispatchEvent(new Event('input'));
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(input<HTMLInputElement>('api-key').value).toBe('synthetic-key ');
});

it('preserves the selection after refresh failure and asks for repair when the model disappears', async () => {
  const { fetchImpl } = await setup('legacy-fake-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  submit();
  await vi.waitFor(() => expect(input('settings-status').textContent).toContain('配置已保存'));
  fetchImpl.mockRejectedValueOnce(new TypeError('network'));
  input<HTMLButtonElement>('refresh-models').click();
  await vi.waitFor(() => expect(input('settings-status').dataset.tone).toBe('error'));
  expect(input<HTMLSelectElement>('model').value).toBe('future-model');
  expect(input<HTMLButtonElement>('save-settings').disabled).toBe(false);
  fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: 'new-model' }] }));
  input<HTMLButtonElement>('refresh-models').click();
  await vi.waitFor(() => expect(input('model-status').textContent).toContain('模型已不在最新列表中'));
  expect(input<HTMLSelectElement>('model').value).toBe('future-model');
  expect(input<HTMLButtonElement>('save-settings').disabled).toBe(true);
});

it('keeps optional test failure independent of saving and suppresses results after editing', async () => {
  const { fetchImpl, store } = await setup('legacy-fake-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  fetchImpl.mockRejectedValueOnce(new TypeError('network'));
  input<HTMLButtonElement>('test-key').click();
  await vi.waitFor(() => expect(input('settings-status').dataset.tone).toBe('error'));
  expect(input<HTMLButtonElement>('save-settings').disabled).toBe(false);
  submit();
  await vi.waitFor(() => expect(input('settings-status').textContent).toContain('配置已保存'));
  expect((await store.read()).activeProviderId).toBe('deepseek');
  let resolveTest!: (response: Response) => void;
  fetchImpl.mockImplementationOnce(() => new Promise((resolve) => { resolveTest = resolve; }));
  input<HTMLButtonElement>('test-key').click();
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  selectModel('<img src=x onerror=alert(1)>');
  resolveTest(new Response('data: {"choices":[{"delta":{"content":"译文"}}]}\n\ndata: [DONE]\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(input('settings-status').textContent).not.toContain('测试翻译成功');
});

it('offers five suppliers without the deferred GLM option', async () => {
  await setup();
  expect(Array.from(input<HTMLSelectElement>('provider').options, (option) => option.value))
    .toEqual(['deepseek', 'minimax', 'kimi', 'openai', 'anthropic']);
  expect(document.body.textContent).not.toContain('待核实');
  expect(input<HTMLInputElement>('api-key').placeholder).toBe('输入所选供应商的 API Key');
});

it('opens a supported supplier for a saved GLM configuration without changing the active configuration', async () => {
  const initialSettings: SettingsSnapshot = {
    activeProviderId: 'glm',
    configurations: { glm: { apiKey: 'synthetic-glm-key', selectedModelId: null, models: [], catalogStatus: 'unfetched', selectionMissing: false } },
  };
  const { store, fetchImpl } = await setup('', initialSettings);
  await vi.waitFor(() => expect(input('active-provider').textContent).toContain('原活动供应商已暂停接入'));
  expect(input<HTMLSelectElement>('provider').value).toBe('deepseek');
  expect(input<HTMLInputElement>('api-key').value).toBe('');
  expect(input<HTMLButtonElement>('save-settings').disabled).toBe(true);
  expect(input('settings-status').textContent).not.toContain('读取本机设置失败');
  expect(await store.read()).toEqual(initialSettings);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('does not overwrite edits made while a configuration save is waiting for storage', async () => {
  const { storage } = await setup('legacy-fake-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  const originalSet = storage.set;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const write = vi.spyOn(storage, 'set').mockImplementationOnce(async (items) => { await pending; await originalSet(items); });
  submit();
  await vi.waitFor(() => expect(write).toHaveBeenCalled());
  changeKey('newer-draft-key');
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(input<HTMLInputElement>('api-key').value).toBe('newer-draft-key');
  expect(input('settings-status').textContent).not.toContain('配置已保存');
});


it.each(['save', 'test'])('recovers an unsaved catalog after worker restart on explicit %s', async (action) => {
  const { store, fetchImpl, restart } = await setup();
  changeKey('synthetic-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  restart();
  if (action === 'save') submit(); else input<HTMLButtonElement>('test-key').click();
  await vi.waitFor(() => expect(input('settings-status').textContent).toContain(action === 'save' ? '配置已保存' : '测试翻译成功'));
  expect(fetchImpl).toHaveBeenCalledTimes(action === 'save' ? 2 : 3);
  expect((await store.read()).activeProviderId).toBe(action === 'save' ? 'deepseek' : null);
});

it('preserves a removed model during recovery without saving or testing it', async () => {
  const { store, fetchImpl, restart } = await setup();
  changeKey('synthetic-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  restart();
  fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: 'replacement-model' }] }));
  input<HTMLButtonElement>('test-key').click();
  await vi.waitFor(() => expect(input('model-status').textContent).toContain('请重新选择'));
  expect(input<HTMLSelectElement>('model').value).toBe('future-model');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect((await store.read()).activeProviderId).toBeNull();
});

it.each(['key', 'provider'])('abandons recovery after the user edits %s', async (edit) => {
  const { store, fetchImpl, restart } = await setup();
  changeKey('synthetic-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  restart();
  let release!: (response: Response) => void;
  fetchImpl.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  submit();
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  if (edit === 'key') changeKey('new-synthetic-key');
  else {
    input<HTMLSelectElement>('provider').value = 'minimax';
    input('provider').dispatchEvent(new Event('change'));
  }
  release(Response.json({ data: [{ id: 'future-model' }] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await store.read()).activeProviderId).toBeNull();
  expect(input('settings-status').textContent).not.toContain('配置已保存');
});


it('does not retry a provider test failure after catalog recovery', async () => {
  const { store, fetchImpl, restart } = await setup();
  changeKey('synthetic-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  restart();
  fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: 'future-model' }] }));
  fetchImpl.mockRejectedValueOnce(new TypeError('network'));
  input<HTMLButtonElement>('test-key').click();
  await vi.waitFor(() => expect(input('settings-status').dataset.tone).toBe('error'));
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect((await store.read()).activeProviderId).toBeNull();
});

it('saves and tests the saved configuration after worker restart without reloading the page', async () => {
  const { fetchImpl, restart } = await setup('legacy-fake-key');
  await vi.waitFor(() => expect(input<HTMLSelectElement>('model').options.length).toBe(3));
  selectModel('future-model');
  submit();
  await vi.waitFor(() => expect(input('settings-status').textContent).toContain('配置已保存'));
  restart();
  input<HTMLButtonElement>('test-key').click();
  await vi.waitFor(() => expect(input('settings-status').textContent).toContain('测试翻译成功'));
  submit();
  await vi.waitFor(() => expect(input('settings-status').textContent).toContain('配置已保存'));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
