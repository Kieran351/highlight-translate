import { AnthropicCompatibleProvider } from './anthropic-compatible-provider';
import type { FetchLike } from './provider-http';

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';

export class AnthropicProvider extends AnthropicCompatibleProvider {
  constructor(fetchImpl?: FetchLike) {
    super(ANTHROPIC_API_BASE, fetchImpl, true);
  }
}
