import { TRANSLATION_SYSTEM_PROMPT } from '../shared/prompt';
import { ProviderFailure } from './provider';
import type { StreamTranslationInput, TranslationProvider } from './provider';

type FetchLike = typeof fetch;

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

interface DeepSeekDelta {
  content?: unknown;
  reasoning_content?: unknown;
}

interface DeepSeekEvent {
  choices?: Array<{ delta?: DeepSeekDelta }>;
}

function errorForStatus(status: number): ProviderFailure {
  if (status === 401 || status === 403) {
    return new ProviderFailure('authentication');
  }
  if (status === 402) {
    return new ProviderFailure('quota');
  }
  if (status === 429) {
    return new ProviderFailure('rate_limit');
  }
  if (status >= 500) {
    return new ProviderFailure('server');
  }
  return new ProviderFailure('server');
}

function parseDataPayload(payload: string, onChunk: (text: string) => void): boolean {
  if (payload === '[DONE]') {
    return true;
  }

  let event: DeepSeekEvent;
  try {
    event = JSON.parse(payload) as DeepSeekEvent;
  } catch {
    throw new ProviderFailure('invalid_stream');
  }

  const content = event.choices?.[0]?.delta?.content;
  if (typeof content === 'string' && content.length > 0) {
    onChunk(content);
  }

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
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
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
    reader.releaseLock();
  }
}

function requestBody(text: string, stream: boolean): string {
  return JSON.stringify({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    stream,
    thinking: { type: 'disabled' },
    ...(stream ? {} : { max_tokens: 1 }),
  });
}

export class DeepSeekProvider implements TranslationProvider {
  constructor(private readonly fetchImpl: FetchLike = defaultFetch) {}

  async stream({ apiKey, text, signal, onChunk }: StreamTranslationInput): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody(text, true),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new ProviderFailure('network');
    }

    if (!response.ok) {
      throw errorForStatus(response.status);
    }
    if (!response.body) {
      throw new ProviderFailure('invalid_stream');
    }

    await parseDeepSeekSse(response.body, onChunk);
  }

  async testConnection(apiKey: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: requestBody('你好', false),
      });
    } catch {
      throw new ProviderFailure('network');
    }

    if (!response.ok) {
      throw errorForStatus(response.status);
    }
  }
}
