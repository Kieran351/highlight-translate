import type { LanguageRoute } from '../shared/types';
import { UI_TEXT } from '../shared/ui-text';

interface DetectedLanguage {
  language: string;
  percentage: number;
}

interface DetectionResult {
  isReliable: boolean;
  languages: DetectedLanguage[];
}

type DetectLanguage = (text: string) => Promise<DetectionResult>;

const LANGUAGE_LABELS: Record<string, string> = {
  ar: UI_TEXT.languageArabic,
  de: UI_TEXT.languageGerman,
  en: UI_TEXT.languageEnglish,
  es: UI_TEXT.languageSpanish,
  fr: UI_TEXT.languageFrench,
  hi: UI_TEXT.languageHindi,
  it: UI_TEXT.languageItalian,
  ja: UI_TEXT.languageJapanese,
  ko: UI_TEXT.languageKorean,
  pt: UI_TEXT.languagePortuguese,
  ru: UI_TEXT.languageRussian,
};

function baseLanguage(code: string): string {
  return code.toLowerCase().split('-')[0] ?? code.toLowerCase();
}

function knownRoute(code: string): LanguageRoute {
  const normalized = baseLanguage(code);
  return {
    kind: 'known',
    code: normalized,
    label: LANGUAGE_LABELS[normalized] ?? code,
  };
}

function unicodeFallback(text: string): LanguageRoute {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kana = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  const hangul = text.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;

  if (kana > 0 && kana + han >= latin + hangul) {
    return { kind: 'known', code: 'ja', label: UI_TEXT.languageJapanese };
  }

  if (hangul > 0 && hangul + han >= latin + kana) {
    return { kind: 'known', code: 'ko', label: UI_TEXT.languageKorean };
  }

  if (han > 0 && han >= latin + kana + hangul) {
    return { kind: 'chinese', label: UI_TEXT.chinese };
  }

  return { kind: 'unknown', label: UI_TEXT.autoDetect };
}

export function createLanguageRouter(detectLanguage: DetectLanguage) {
  return async (text: string): Promise<LanguageRoute> => {
    const result = await detectLanguage(text.trim());
    const primary = result.languages[0];

    if (result.isReliable && primary) {
      const code = baseLanguage(primary.language);
      if (code === 'zh') {
        return { kind: 'chinese', label: UI_TEXT.chinese };
      }
      return knownRoute(primary.language);
    }

    return unicodeFallback(text);
  };
}
