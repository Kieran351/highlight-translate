import { MAX_SELECTION_LENGTH } from '../shared/constants';

export type SelectionEvaluation =
  | { kind: 'invalid' }
  | { kind: 'valid'; text: string }
  | { kind: 'too-long'; text: string };

const URL_PATTERN = /^(?:https?:\/\/|www\.)\S+$/iu;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const NATURAL_LANGUAGE_CHARACTER = /\p{L}/u;

export function evaluateSelection(text: string): SelectionEvaluation {
  const validationText = text.trim();

  if (
    validationText.length === 0
    || !NATURAL_LANGUAGE_CHARACTER.test(validationText)
    || URL_PATTERN.test(validationText)
    || EMAIL_PATTERN.test(validationText)
  ) {
    return { kind: 'invalid' };
  }

  if (text.length > MAX_SELECTION_LENGTH) {
    return { kind: 'too-long', text };
  }

  return { kind: 'valid', text };
}

export function isEditableNode(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;

  return Boolean(element?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'));
}
