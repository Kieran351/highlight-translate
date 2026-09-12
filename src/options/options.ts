import './options.css';

import type { SettingsMessage, SettingsResponse } from '../shared/messages';
import { PROVIDERS } from '../shared/providers';
import type { ProviderId, ProviderModel, SettingsSnapshot } from '../shared/types';
import { UI_TEXT } from '../shared/ui-text';
import type { UiTextKey } from '../shared/ui-text';

function element<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing options element: ${selector}`);
  return node;
}
for (const node of document.querySelectorAll<HTMLElement>('[data-ui-text]')) {
  node.textContent = UI_TEXT[node.dataset.uiText as UiTextKey];
}
for (const node of document.querySelectorAll<HTMLInputElement>('[data-ui-placeholder]')) {
  node.placeholder = UI_TEXT[node.dataset.uiPlaceholder as UiTextKey];
}
const form = element<HTMLFormElement>('#settings-form');
const providerInput = element<HTMLSelectElement>('#provider');
const keyInput = element<HTMLInputElement>('#api-key');
const modelInput = element<HTMLSelectElement>('#model');
const refreshButton = element<HTMLButtonElement>('#refresh-models');
const saveButton = element<HTMLButtonElement>('#save-settings');
const clearButton = element<HTMLButtonElement>('#clear-key');
const testButton = element<HTMLButtonElement>('#test-key');
const toggleButton = element<HTMLButtonElement>('#toggle-key');
const status = element<HTMLElement>('#settings-status');
const modelStatus = element<HTMLElement>('#model-status');
interface Draft {
  apiKey: string;
  modelId: string;
  models: ProviderModel[];
  ready: boolean;
  catalogToken?: string;
  receivedCount?: number;
}
let settings: SettingsSnapshot = { activeProviderId: null, configurations: {} };
const drafts = new Map<ProviderId, Draft>();
let providerId: ProviderId = 'deepseek';
let revision = 0;
let refreshRevision = 0;
let mutationRevision = 0;
let loading = false;
let testing = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function draft(): Draft {
  let value = drafts.get(providerId);
  if (!value) {
    const saved = settings.configurations[providerId];
    value = { apiKey: saved?.apiKey ?? '', modelId: saved?.selectedModelId ?? '', models: saved?.models ?? [], ready: saved?.catalogStatus === 'ready' };
    drafts.set(providerId, value);
  }
  return value;
}
function available(): boolean { return PROVIDERS.find((provider) => provider.id === providerId)?.availability === 'available'; }
function setStatus(message: string, tone = 'neutral'): void {
  status.textContent = message;
  status.dataset.tone = tone;
}
function validSelection(): boolean {
  const value = draft();
  return available() && Boolean(value.apiKey.trim()) && value.ready && value.models.some((model) => model.id === value.modelId && model.supportsText !== false);
}
function renderModels(): void {
  const value = draft();
  modelInput.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '请选择翻译模型';
  modelInput.append(placeholder);
  if (value.modelId && !value.models.some((model) => model.id === value.modelId)) {
    const missing = document.createElement('option');
    missing.value = value.modelId;
    missing.textContent = `${value.modelId}（模型已不在最新列表中）`;
    missing.disabled = true;
    modelInput.append(missing);
  }
  for (const model of value.models.filter((item) => item.supportsText !== false)) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name ? `${model.name} · ${model.id}` : model.id;
    modelInput.append(option);
  }
  modelInput.value = value.modelId;
  modelStatus.textContent = loading ? '正在获取完整模型列表…' : !available() ? providerId === 'glm' ? '智谱国内站模型列表接口待核实，暂不能选择模型。' : '此供应商的接入尚未开放。'
    : !value.ready ? '填写 API Key 后自动获取模型列表。'
    : value.modelId && !value.models.some((model) => model.id === value.modelId) ? '模型已不在最新列表中，请重新选择并保存。'
    : value.models.length === 0 ? value.receivedCount ? '列表中的模型均明确不支持文本翻译，暂无可选模型。' : '模型列表为空，请稍后刷新或检查账号权限。'
    : '模型列表已获取。选择模型后可直接保存，无需先测试。';
  updateButtons();
}
function updateButtons(): void {
  refreshButton.disabled = !available() || !keyInput.value.trim() || loading;
  modelInput.disabled = !available() || !draft().ready || loading;
  keyInput.disabled = !available();
  saveButton.disabled = !validSelection() || loading;
  testButton.disabled = !validSelection() || loading || testing;
}
function render(): void {
  const provider = PROVIDERS.find((item) => item.id === providerId)!;
  providerInput.value = providerId;
  keyInput.value = draft().apiKey;
  keyInput.type = 'password';
  toggleButton.textContent = UI_TEXT.show;
  element('#provider-note').textContent = provider.platformLabel;
  element('#active-provider').textContent = settings.activeProviderId
    ? `当前使用：${PROVIDERS.find((item) => item.id === settings.activeProviderId)?.label ?? settings.activeProviderId}`
    : '尚未启用远程翻译配置';
  renderModels();
}
async function send(message: SettingsMessage): Promise<Extract<SettingsResponse, { ok: true }>> {
  const response = await chrome.runtime.sendMessage<SettingsMessage, SettingsResponse>(message);
  if (!response?.ok) throw new Error(response?.message ?? UI_TEXT.connectionFailed);
  return response;
}
function invalidate(): void {
  revision += 1;
  refreshRevision += 1;
  clearTimeout(timer);
  loading = false;
  testing = false;
  setStatus('');
}
async function refresh(): Promise<void> {
  clearTimeout(timer);
  const value = draft();
  if (!available() || !value.apiKey.trim()) return;
  const request = ++refreshRevision;
  const edited = revision;
  const selectedProvider = providerId;
  const key = value.apiKey.trim();
  loading = true;
  renderModels();
  try {
    const response = await send({ type: 'refresh-models', providerId: selectedProvider, apiKey: key });
    if (request !== refreshRevision || edited !== revision) return;
    if (!response.models || !response.catalogToken) throw new Error('模型列表响应无效，请重试。');
    value.models = response.models;
    value.receivedCount = response.catalogSummary?.receivedCount;
    value.ready = true;
    value.catalogToken = response.catalogToken;
    setStatus('模型列表获取成功。', 'success');
  } catch (error) {
    if (request === refreshRevision && edited === revision) setStatus(error instanceof Error ? error.message : '模型列表获取失败，请重试。', 'error');
  } finally {
    if (request === refreshRevision && edited === revision) { loading = false; renderModels(); }
  }
}
for (const provider of PROVIDERS) {
  const option = document.createElement('option');
  option.value = provider.id;
  option.textContent = provider.label;
  providerInput.append(option);
}
providerInput.addEventListener('change', () => {
  invalidate();
  providerId = providerInput.value as ProviderId;
  render();
  if (!draft().ready && draft().apiKey.trim()) void refresh();
});
function editKey(): void {
  const value = draft();
  if (value.apiKey === keyInput.value) return;
  invalidate();
  const sameKey = value.apiKey.trim() === keyInput.value.trim();
  value.apiKey = keyInput.value;
  if (!sameKey) { value.models = []; value.modelId = ''; value.ready = false; delete value.catalogToken; }
  renderModels();
  if (!sameKey && value.apiKey.trim()) timer = setTimeout(() => { void refresh(); }, 500);
}
keyInput.addEventListener('input', editKey);
keyInput.addEventListener('change', () => { editKey(); if (!draft().ready) void refresh(); });
modelInput.addEventListener('change', () => { invalidate(); draft().modelId = modelInput.value; renderModels(); });
refreshButton.addEventListener('click', () => { void refresh(); });
toggleButton.addEventListener('click', () => {
  const show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  toggleButton.textContent = show ? UI_TEXT.hide : UI_TEXT.show;
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!validSelection() || loading) return;
  const value = draft();
  const edited = revision;
  const mutation = ++mutationRevision;
  void send({ type: 'save-settings', providerId, apiKey: value.apiKey.trim(), modelId: value.modelId, catalogToken: value.catalogToken }).then((response) => {
    if (response.settings && mutation === mutationRevision) settings = response.settings;
    if (edited !== revision) return;
    render();
    setStatus('配置已保存并启用，将用于后续翻译。', 'success');
  }).catch((error: unknown) => { if (edited === revision) setStatus(error instanceof Error ? error.message : UI_TEXT.keySaveFailed, 'error'); });
});
clearButton.addEventListener('click', () => {
  const selectedProvider = providerId;
  invalidate();
  const edited = revision;
  const mutation = ++mutationRevision;
  void send({ type: 'clear-settings', providerId: selectedProvider }).then((response) => {
    if (response.settings && mutation === mutationRevision) settings = response.settings;
    if (edited !== revision) return;
    drafts.delete(selectedProvider);
    render();
    setStatus('已清除此供应商的配置。', 'success');
  }).catch((error: unknown) => { if (edited === revision) setStatus(error instanceof Error ? error.message : UI_TEXT.keyClearFailed, 'error'); });
});
testButton.addEventListener('click', () => {
  if (!validSelection()) return;
  const value = draft();
  const edited = revision;
  testing = true;
  updateButtons();
  setStatus('正在测试翻译…');
  void send({ type: 'test-connection', providerId, apiKey: value.apiKey.trim(), modelId: value.modelId, catalogToken: value.catalogToken }).then(() => {
    if (edited === revision) setStatus('测试翻译成功。配置仍需点击保存并启用。', 'success');
  }).catch((error: unknown) => { if (edited === revision) setStatus(error instanceof Error ? error.message : UI_TEXT.connectionFailed, 'error'); })
    .finally(() => { if (edited === revision) { testing = false; updateButtons(); } });
});
render();
const initialRevision = revision;
const initialMutation = mutationRevision;
void send({ type: 'get-settings' }).then((response) => {
  if (!response.settings) throw new Error(UI_TEXT.settingsReadFailed);
  if (initialMutation === mutationRevision) settings = response.settings;
  if (initialRevision !== revision) return;
  drafts.clear();
  providerId = settings.activeProviderId ?? 'deepseek';
  render();
  if (!draft().ready && draft().apiKey.trim()) void refresh();
}).catch(() => { if (initialRevision === revision) setStatus(UI_TEXT.settingsReadFailed, 'error'); });
