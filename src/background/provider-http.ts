import { ProviderFailure } from './provider';

export type FetchLike = typeof fetch;
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function failureForStatus(status: number): ProviderFailure {
  if (status === 401 || status === 403) return new ProviderFailure('authentication');
  if (status === 402) return new ProviderFailure('quota');
  if (status === 429) return new ProviderFailure('rate_limit');
  return new ProviderFailure('server');
}

export async function providerFetch(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error' });
    if (!response.ok) throw failureForStatus(response.status);
    // Also enforce the boundary with injected transports that follow redirects.
    if (response.redirected || (response.url && new URL(response.url).origin !== new URL(url).origin)) {
      throw new ProviderFailure('network');
    }
    return response;
  } catch (error) {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('network');
  }
}

export async function readModelJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (!isRecord(value)) throw new ProviderFailure('invalid_models');
    return value;
  } catch {
    throw new ProviderFailure('invalid_models');
  }
}

export function parseStreamJson(data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    if (!isRecord(value)) throw new ProviderFailure('invalid_stream');
    return value;
  } catch {
    throw new ProviderFailure('invalid_stream');
  }
}

export function streamError(value: unknown): ProviderFailure {
  const type = isRecord(value) ? value.type ?? value.code : undefined;
  if (type === 'authentication_error' || type === 'permission_error') return new ProviderFailure('authentication');
  if (type === 'rate_limit_error') return new ProviderFailure('rate_limit');
  if (type === 'insufficient_quota' || type === 'billing_error') return new ProviderFailure('quota');
  return new ProviderFailure('server');
}

/** SSE line framing is independent of UTF-8 and network chunk boundaries. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: string, data: string) => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let event = '';
  let data: string[] = [];
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const line = (text: string): boolean => {
    if (!text) {
      const complete = data.length > 0 && onEvent(event, data.join('\n'));
      event = '';
      data = [];
      return complete;
    }
    if (text.startsWith(':')) return false;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /u, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    return false;
  };
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      pending += decoder.decode(value, { stream: !done });
      // Bound malformed frames without restricting the total translated output.
      if (pending.length + data.join('').length > 1_048_576) throw new ProviderFailure('invalid_stream');
      let boundary = pending.search(/[\r\n]/u);
      while (boundary >= 0) {
        if (pending[boundary] === '\r' && boundary === pending.length - 1 && !done) break;
        const text = pending.slice(0, boundary);
        const width = pending.slice(boundary, boundary + 2) === '\r\n' ? 2 : 1;
        pending = pending.slice(boundary + width);
        if (line(text)) return;
        boundary = pending.search(/[\r\n]/u);
      }
      if (done) throw new ProviderFailure('invalid_stream');
    }
  } catch (error) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('network');
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
