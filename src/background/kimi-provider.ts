import { ChatCompatibleProvider } from './chat-compatible-provider';
import type { FetchLike } from './provider-http';

export const KIMI_API_BASE = 'https://api.moonshot.cn/v1';

export class KimiProvider extends ChatCompatibleProvider {
  constructor(fetchImpl?: FetchLike) {
    super(KIMI_API_BASE, fetchImpl);
  }
}
