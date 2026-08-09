import { describe, expect, it } from 'vitest';

import { evaluateSelection } from '../../src/content/selection-policy';

describe('selection policy', () => {
  it.each(['   ', '12345', '...?!', '😀🎉', 'https://example.com', 'person@example.com'])(
    'rejects non-language-only selection: %s',
    (text) => {
      expect(evaluateSelection(text)).toEqual({ kind: 'invalid' });
    },
  );

  it.each(['hello', '中', 'const userName = value;', 'Read https://example.com now', '发邮件到 person@example.com']) (
    'accepts natural-language selections without rewriting them: %s',
    (text) => {
      expect(evaluateSelection(text)).toEqual({ kind: 'valid', text });
    },
  );

  it('keeps the trigger for overlong content but marks it locally', () => {
    const text = `a${'字'.repeat(5_000)}`;

    expect(evaluateSelection(text)).toEqual({ kind: 'too-long', text });
  });
});
