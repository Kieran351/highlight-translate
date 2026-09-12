import type { ProviderId } from './types';

export interface ProviderMetadata {
  id: ProviderId;
  label: string;
  platformLabel: string;
  availability: 'available' | 'pending';
  website: string;
}

export const PROVIDERS: readonly ProviderMetadata[] = [
  { id: 'deepseek', label: 'DeepSeek', platformLabel: '官方 API', availability: 'available', website: 'https://platform.deepseek.com/' },
  { id: 'minimax', label: 'MiniMax', platformLabel: '中国大陆官方 API', availability: 'available', website: 'https://platform.minimax.cn/' },
  { id: 'glm', label: 'GLM / 智谱', platformLabel: '中国大陆官方 API · 模型列表接口待核实', availability: 'pending', website: 'https://bigmodel.cn/' },
  { id: 'kimi', label: 'Kimi / 月之暗面', platformLabel: '中国大陆官方 API', availability: 'pending', website: 'https://platform.kimi.com/' },
  { id: 'openai', label: 'OpenAI', platformLabel: '官方 API', availability: 'pending', website: 'https://platform.openai.com/' },
  { id: 'anthropic', label: 'Anthropic', platformLabel: '官方 API', availability: 'pending', website: 'https://platform.claude.com/' },
];
