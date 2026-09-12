import { TRANSLATION_SYSTEM_PROMPT } from '../shared/prompt';
import type { ProviderModel } from '../shared/types';
import { ProviderFailure } from './provider';
import type { CatalogProvider, ListModelsInput, StreamTranslationInput } from './provider';
import { defaultFetch, isRecord, parseStreamJson, providerFetch, readModelJson, readSse, streamError } from './provider-http';
import type { FetchLike } from './provider-http';

export class AnthropicCompatibleProvider implements CatalogProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly versionHeader = false,
  ) {}

  private headers(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      ...(this.versionHeader ? { 'anthropic-version': '2023-06-01' } : {}),
    };
  }

  async listModels({ apiKey, signal }: ListModelsInput): Promise<ProviderModel[]> {
    const models = new Map<string, ProviderModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const url = `${this.baseUrl}/models${cursor ? `?after_id=${encodeURIComponent(cursor)}` : ''}`;
      const response = await providerFetch(this.fetchImpl, url, { headers: this.headers(apiKey), signal });
      const page = await readModelJson(response);
      if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw new ProviderFailure('invalid_models');
      for (const item of page.data) {
        if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) throw new ProviderFailure('invalid_models');
        if (item.display_name !== undefined && typeof item.display_name !== 'string') throw new ProviderFailure('invalid_models');
        models.set(item.id, { id: item.id, ...(typeof item.display_name === 'string' ? { name: item.display_name } : {}) });
      }
      if (!page.has_more) return [...models.values()];
      if (typeof page.last_id !== 'string' || !page.last_id || page.data.length === 0 || cursors.has(page.last_id)) {
        throw new ProviderFailure('invalid_models');
      }
      cursor = page.last_id;
      cursors.add(cursor);
      if (cursors.size > 1000) throw new ProviderFailure('invalid_models');
    } while (!signal.aborted);
    throw new DOMException('Aborted', 'AbortError');
  }

  async stream({ apiKey, modelId, text, signal, onChunk }: StreamTranslationInput): Promise<void> {
    if (!modelId) throw new ProviderFailure('invalid_configuration');
    const response = await providerFetch(this.fetchImpl, `${this.baseUrl}/messages`, {
      method: 'POST',
      headers: { ...this.headers(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, max_tokens: 4096, system: TRANSLATION_SYSTEM_PROMPT, messages: [{ role: 'user', content: text }], stream: true }),
      signal,
    });
    if (!response.body) throw new ProviderFailure('invalid_stream');
    let normalStop = false;
    let hasText = false;
    const textBlocks = new Set<number>();
    await readSse(response.body, signal, (eventName, data) => {
      const event = parseStreamJson(data);
      if (eventName && eventName !== event.type) throw new ProviderFailure('invalid_stream');
      if (event.type === 'error') throw streamError(event.error);
      if (event.type === 'content_block_start' && isRecord(event.content_block) && event.content_block.type === 'text' && typeof event.index === 'number') {
        textBlocks.add(event.index);
        const initial = event.content_block.text;
        if (typeof initial === 'string' && initial) { hasText = true; onChunk(initial); }
      }
      if (event.type === 'content_block_delta' && isRecord(event.delta) && event.delta.type === 'text_delta') {
        if (typeof event.index !== 'number' || !textBlocks.has(event.index) || typeof event.delta.text !== 'string') throw new ProviderFailure('invalid_stream');
        if (event.delta.text) { hasText = true; onChunk(event.delta.text); }
      }
      if (event.type === 'content_block_stop' && typeof event.index === 'number') textBlocks.delete(event.index);
      if (event.type === 'message_delta' && isRecord(event.delta) && event.delta.stop_reason != null) {
        normalStop = event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'stop_sequence';
        if (!normalStop) throw new ProviderFailure('invalid_stream');
      }
      if (event.type === 'message_stop') {
        if (!normalStop) throw new ProviderFailure('invalid_stream');
        if (!hasText) throw new ProviderFailure('empty_response');
        return true;
      }
      return false;
    });
  }

  async testConnection(apiKey: string, modelId?: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try { await this.stream({ apiKey, modelId, text: 'Hello', signal: controller.signal, onChunk: () => undefined }); }
    finally { clearTimeout(timer); }
  }
}
