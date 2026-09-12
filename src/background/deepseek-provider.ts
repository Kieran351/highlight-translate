import type { ProviderModel } from '../shared/types';
import { TRANSLATION_SYSTEM_PROMPT } from '../shared/prompt';
import { ProviderFailure } from './provider';
import type { StreamTranslationInput, CatalogProvider, ListModelsInput } from './provider';

import { defaultFetch, isRecord, parseStreamJson, providerFetch, readModelJson, streamError } from './provider-http';
import type { FetchLike } from './provider-http';

export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

function parseDataPayload(payload: string, onChunk: (text: string) => void): boolean {
  if (payload === '[DONE]') return true;
  const event = parseStreamJson(payload);
  if (event.error) throw streamError(event.error);
  if (!Array.isArray(event.choices)) throw new ProviderFailure('invalid_stream');
  if (event.choices.length === 0) return false;
  const choice: unknown = event.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) throw new ProviderFailure('invalid_stream');
  const content = choice.delta.content;
  if (content != null && typeof content !== 'string') throw new ProviderFailure('invalid_stream');
  if (typeof content === 'string' && content) onChunk(content);
  // Preserve compatibility with legacy streams without finish_reason, but never
  // turn an explicit truncation, tool call or service interruption into success.
  if (choice.finish_reason != null && choice.finish_reason !== 'stop') throw new ProviderFailure('invalid_stream');
  return false;
}

function processEventBlock(block: string, onChunk: (text: string) => void): boolean {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  return data ? parseDataPayload(data, onChunk) : false;
}

export async function parseDeepSeekSse(
  body: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll('\r\n', '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (processEventBlock(block, onChunk)) {
          return;
        }
        boundary = buffer.indexOf('\n\n');
      }

      if (done) {
        if (buffer.trim()) {
          if (processEventBlock(buffer, onChunk)) {
            return;
          }
        }
        throw new ProviderFailure('invalid_stream');
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function requestBody(text: string, stream: boolean, modelId = DEEPSEEK_MODEL): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    stream,
    thinking: { type: 'disabled' },
    ...(stream ? {} : { max_tokens: 1 }),
  });
}

export class DeepSeekProvider implements CatalogProvider {
  constructor(private readonly fetchImpl: FetchLike = defaultFetch) {}

  async listModels({ apiKey, signal }: ListModelsInput): Promise<ProviderModel[]> {
    const response = await providerFetch(this.fetchImpl, 'https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${apiKey}` }, signal,
    });
    const body = await readModelJson(response);
    if (!Array.isArray(body.data) || (body.has_more !== undefined && body.has_more !== false)
      || body.next != null || body.next_page != null || body.next_cursor != null) throw new ProviderFailure('invalid_models');
    return body.data.map((model: unknown) => {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) throw new ProviderFailure('invalid_models');
      return { id: model.id };
    });
  }

  async stream({ apiKey, modelId, text, signal, onChunk }: StreamTranslationInput): Promise<void> {
    const response = await providerFetch(this.fetchImpl, DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: requestBody(text, true, modelId),
      signal,
    });
    if (!response.body) throw new ProviderFailure('invalid_stream');
    await parseDeepSeekSse(response.body, onChunk, signal);
  }

  async testConnection(apiKey: string, modelId?: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      await providerFetch(this.fetchImpl, DEEPSEEK_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        body: requestBody('你好', false, modelId),
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  }
}
