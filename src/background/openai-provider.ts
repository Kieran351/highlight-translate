import { TRANSLATION_SYSTEM_PROMPT } from '../shared/prompt';
import type { ProviderModel } from '../shared/types';
import { listChatModels, streamChatResponse } from './chat-compatible-provider';
import { ProviderFailure } from './provider';
import type { CatalogProvider, ListModelsInput, StreamTranslationInput } from './provider';
import { defaultFetch, isRecord, parseStreamJson, providerFetch, readSse, streamError } from './provider-http';
import type { FetchLike } from './provider-http';

export const OPENAI_API_BASE = 'https://api.openai.com/v1';

// Negative capability evidence only. Unknown and text-capable audio/vision models remain selectable.
// https://developers.openai.com/api/docs/models (individual category pages in provider-evidence.md).
function cannotTranslateSelection(id: string): boolean {
  return /^(?:text-embedding-|dall-e-|gpt-image-|tts-1(?:-|$)|whisper-1(?:-|$)|omni-moderation-|text-moderation-|sora-)/u.test(id)
    || /^gpt-4o(?:-mini)?-(?:tts|transcribe)(?:-|$)/u.test(id);
}

// Protocol mapping is not a model allowlist: all other API IDs use Responses.
// These older model families are documented for Chat Completions.
function usesLegacyChat(id: string): boolean {
  const baseModel = id.startsWith('ft:') ? id.split(':')[1] ?? id : id;
  return /^gpt-3\.5-turbo(?:$|-(?:0125|1106|0613|0301|16k)(?:-|$))/u.test(baseModel)
    || /^gpt-4(?:$|-(?:0314|0613|32k|turbo|0125-preview|1106-preview|1106-vision-preview|vision-preview)(?:-|$))/u.test(baseModel);
}

export class OpenAIProvider implements CatalogProvider {
  constructor(private readonly fetchImpl: FetchLike = defaultFetch) {}

  async listModels(input: ListModelsInput): Promise<ProviderModel[]> {
    const models = await listChatModels(this.fetchImpl, `${OPENAI_API_BASE}/models`, input);
    return models.map((model) => cannotTranslateSelection(model.id) ? { ...model, supportsText: false } : model);
  }

  async stream({ apiKey, modelId, text, signal, onChunk }: StreamTranslationInput): Promise<void> {
    if (!modelId) throw new ProviderFailure('invalid_configuration');
    const legacyChat = usesLegacyChat(modelId);
    const body = legacyChat
      ? { model: modelId, messages: [{ role: 'system', content: TRANSLATION_SYSTEM_PROMPT }, { role: 'user', content: text }], store: false, stream: true }
      : { model: modelId, instructions: TRANSLATION_SYSTEM_PROMPT, input: text, store: false, stream: true };
    const response = await providerFetch(this.fetchImpl, `${OPENAI_API_BASE}/${legacyChat ? 'chat/completions' : 'responses'}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (legacyChat) return streamChatResponse(response, signal, onChunk);
    if (!response.body) throw new ProviderFailure('invalid_stream');
    let hasText = false;
    await readSse(response.body, signal, (eventName, data) => {
      const event = parseStreamJson(data);
      if (eventName && eventName !== event.type) throw new ProviderFailure('invalid_stream');
      if (event.type === 'error') throw streamError({ code: event.code });
      if (event.type === 'response.failed') throw streamError(isRecord(event.response) ? event.response.error : undefined);
      if (event.type === 'response.incomplete') throw new ProviderFailure('invalid_stream');
      if (event.type === 'response.output_text.delta') {
        if (typeof event.delta !== 'string') throw new ProviderFailure('invalid_stream');
        if (event.delta) { hasText = true; onChunk(event.delta); }
      }
      if (event.type === 'response.completed') {
        if (!isRecord(event.response) || event.response.status !== 'completed') throw new ProviderFailure('invalid_stream');
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
