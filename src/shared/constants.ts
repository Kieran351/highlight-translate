export const PORT_NAME = 'highlight-translate';
export const API_KEY_STORAGE_KEY = 'deepseekApiKey';
export const MAX_SELECTION_LENGTH = 5_000;

export const TRANSLATION_TIMEOUTS = {
  firstContentMs: 20_000,
  idleMs: 20_000,
  totalMs: 120_000,
} as const;
