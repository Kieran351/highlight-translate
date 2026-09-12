// @vitest-environment happy-dom
import optionsHtml from '../../options.html?raw';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfigurationStore } from '../../src/background/configuration-store';
import { ConfigurationManager } from '../../src/background/configuration-manager';
import { DeepSeekProvider } from '../../src/background/deepseek-provider';
import { createSettingsMessageHandler } from '../../src/background/settings-handler';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function setup(legacy = '') {
  const values: Record<string, unknown> = { deepseekApiKey: legacy };
  const storage = {
    get: async () => structuredClone(values),
    set: async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); },
    remove: async (key: string) => { delete values[key]; },
  };
  const store = new ConfigurationStore(storage);
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response('data: {"choices":[{"delta":{"content":"测试译文"}}]}\n\ndata: [DONE]\n\n')
    : Response.json({ data: [{ id: 'future-model' }, { id: '<img src=x onerror=alert(1)>' }] }));
  const manager = new ConfigurationManager({ store, resolveProvider: () => new DeepSeekProvider(fetchImpl) });
  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
  const handle = createSettingsMessageHandler({ extensionId: sender.id, extensionUrl: 'chrome-extension://extension-id/', manager });
  vi.stubGlobal('chrome', { runtime: { sendMessage: (message: unknown) => handle(message, sender) } });
  document.documentElement.innerHTML = optionsHtml;
  await import('../../src/options/options');
  await vi.waitFor(() => expect(document.querySelector('#active-provider')?.textContent).toBeTruthy());
  return { store, fetchImpl, manager, storage };
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

it('shows GLM as pending verification without misreporting unsupported', async () => {
  await setup();
  input<HTMLSelectElement>('provider').value = 'glm';
  input('provider').dispatchEvent(new Event('change'));
  expect(input('provider-note').textContent).toContain('待核实');
  expect(input<HTMLButtonElement>('save-settings').disabled).toBe(true);
  expect(document.body.textContent).not.toContain('暂不支持该供应商');
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
