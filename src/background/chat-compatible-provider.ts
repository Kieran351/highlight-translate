import { TRANSLATION_SYSTEM_PROMPT } from '../shared/prompt';
import type { ProviderModel } from '../shared/types';
import { ProviderFailure } from './provider';
import type { CatalogProvider, ListModelsInput, StreamTranslationInput } from './provider';
import { defaultFetch, isRecord, parseStreamJson, providerFetch, readModelJson, readSse, streamError } from './provider-http';
import type { FetchLike } from './provider-http';

export async function listChatModels(fetchImpl: FetchLike, url: string, { apiKey, signal }: ListModelsInput): Promise<ProviderModel[]> {
  const response = await providerFetch(fetchImpl, url, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
  const page = await readModelJson(response);
  if (page.object !== 'list' || !Array.isArray(page.data) || (page.has_more !== undefined && page.has_more !== false)
    || page.next != null || page.next_page != null || page.next_cursor != null) throw new ProviderFailure('invalid_models');
  const models = new Map<string, ProviderModel>();
  for (const item of page.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) throw new ProviderFailure('invalid_models');
    models.set(item.id, { id: item.id });
  }
  return [...models.values()];
}

export async function streamChatResponse(response: Response, signal: AbortSignal, onChunk: (text: string) => void): Promise<void> {
  if (!response.body) throw new ProviderFailure('invalid_stream');
  let stopped = false;
  let hasText = false;
  await readSse(response.body, signal, (_eventName, data) => {
    if (data === '[DONE]') {
      if (!stopped) throw new ProviderFailure('invalid_stream');
      if (!hasText) throw new ProviderFailure('empty_response');
      return true;
    }
    const event = parseStreamJson(data);
    if (event.error) throw streamError(event.error);
    if (!Array.isArray(event.choices)) throw new ProviderFailure('invalid_stream');
    if (event.choices.length === 0) return false; // Final usage-only event.
    const choice: unknown = event.choices[0];
    if (!isRecord(choice) || !isRecord(choice.delta)) throw new ProviderFailure('invalid_stream');
    const content = choice.delta.content;
    if (content != null && typeof content !== 'string') throw new ProviderFailure('invalid_stream');
    if (typeof content === 'string' && content) {
      if (stopped) throw new ProviderFailure('invalid_stream');
      hasText = true;
      onChunk(content);
    }
    if (choice.finish_reason != null) {
      if (choice.finish_reason !== 'stop') throw new ProviderFailure('invalid_stream');
      stopped = true;
    }
    return false;
  });
}

export class ChatCompatibleProvider implements CatalogProvider {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: FetchLike = defaultFetch) {}

  listModels(input: ListModelsInput): Promise<ProviderModel[]> {
    return listChatModels(this.fetchImpl, `${this.baseUrl}/models`, input);
  }

  async stream({ apiKey, modelId, text, signal, onChunk }: StreamTranslationInput): Promise<void> {
    if (!modelId) throw new ProviderFailure('invalid_configuration');
    const response = await providerFetch(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'system', content: TRANSLATION_SYSTEM_PROMPT }, { role: 'user', content: text }], stream: true }),
      signal,
    });
    await streamChatResponse(response, signal, onChunk);
  }

  async testConnection(apiKey: string, modelId?: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try { await this.stream({ apiKey, modelId, text: 'Hello', signal: controller.signal, onChunk: () => undefined }); }
    finally { clearTimeout(timer); }
  }
}
