import { describe, expect, it } from 'vitest';

import {
  applyServerMessage,
  beginRequest,
  beginRetry,
  canCopyResult,
  createCardState,
} from '../../src/content/card-state';

describe('translation card state', () => {
  it('ignores events from stale request ids', () => {
    const current = beginRequest(createCardState(), 'current');

    expect(applyServerMessage(current, {
      type: 'chunk',
      requestId: 'stale',
      text: '旧结果',
    })).toBe(current);
  });

  it('enables copy only after a complete result', () => {
    let state = beginRequest(createCardState(), 'r1');
    state = applyServerMessage(state, { type: 'chunk', requestId: 'r1', text: '译文' });
    expect(canCopyResult(state)).toBe(false);

    state = applyServerMessage(state, { type: 'complete', requestId: 'r1' });
    expect(state.status).toBe('complete');
    expect(canCopyResult(state)).toBe(true);
  });

  it('keeps partial output visible and copyable after an interrupted stream', () => {
    let state = beginRequest(createCardState(), 'r2');
    state = applyServerMessage(state, { type: 'chunk', requestId: 'r2', text: '部分译文' });
    state = applyServerMessage(state, {
      type: 'error',
      requestId: 'r2',
      code: 'network',
      message: '网络连接失败，请检查网络后重试。',
      retryable: true,
      partial: true,
    });

    expect(state.status).toBe('partial');
    expect(state.text).toBe('部分译文');
    expect(canCopyResult(state)).toBe(true);
  });

  it('keeps an old partial result until the first retry chunk replaces it', () => {
    const partial = {
      ...createCardState(),
      requestId: 'old',
      text: '旧的部分结果',
      status: 'partial' as const,
    };
    let state = beginRetry(partial, 'new');

    expect(state.text).toBe('旧的部分结果');
    expect(state.replaceOnNextChunk).toBe(true);

    state = applyServerMessage(state, { type: 'chunk', requestId: 'new', text: '新' });
    expect(state.text).toBe('新');
    expect(state.replaceOnNextChunk).toBe(false);
  });

  it('keeps a retry failure partial and copyable when no new chunk arrived', () => {
    const partial = {
      ...createCardState(),
      requestId: 'old',
      text: '旧的部分结果',
      status: 'partial' as const,
    };
    let state = beginRetry(partial, 'new');

    state = applyServerMessage(state, {
      type: 'error',
      requestId: 'new',
      code: 'network',
      message: '网络连接失败，请检查网络后重试。',
      retryable: true,
      partial: false,
    });

    expect(state.status).toBe('partial');
    expect(state.text).toBe('旧的部分结果');
    expect(canCopyResult(state)).toBe(true);
  });
});
