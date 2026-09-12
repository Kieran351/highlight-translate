import { AnthropicCompatibleProvider } from './anthropic-compatible-provider';
import type { FetchLike } from './provider-http';

export const MINIMAX_API_BASE = 'https://api.minimax.cn/anthropic/v1';

export class MiniMaxProvider extends AnthropicCompatibleProvider {
  constructor(fetchImpl?: FetchLike) {
    super(MINIMAX_API_BASE, fetchImpl);
  }
}
