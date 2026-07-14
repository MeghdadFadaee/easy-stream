import type { ProbeStream } from './types.js';

const LANGUAGE_ALIASES: Record<string, string> = {
  ara: 'ar', ar: 'ar',
  chi: 'zh', zho: 'zh', zh: 'zh',
  dut: 'nl', nld: 'nl', nl: 'nl',
  eng: 'en', en: 'en',
  fas: 'fa', per: 'fa', fa: 'fa', pes: 'fa',
  fre: 'fr', fra: 'fr', fr: 'fr',
  ger: 'de', deu: 'de', de: 'de',
  heb: 'he', he: 'he',
  hin: 'hi', hi: 'hi',
  ita: 'it', it: 'it',
  jpn: 'ja', ja: 'ja',
  kor: 'ko', ko: 'ko',
  por: 'pt', pt: 'pt',
  rus: 'ru', ru: 'ru',
  spa: 'es', es: 'es',
  tur: 'tr', tr: 'tr',
  und: 'und', unknown: 'und', qad: 'und',
};

export function detectTextLanguage(text: string): string | undefined {
  const clean = text.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' ');
  const arabicScript = (clean.match(/[\u0600-\u06ff]/gu) ?? []).length;
  const persianSpecific = (clean.match(/[پچژگک‌ی]/gu) ?? []).length;
  const kana = (clean.match(/[\u3040-\u30ff]/gu) ?? []).length;
  const han = (clean.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const cjk = kana + han;
  const hangul = (clean.match(/[\uac00-\ud7af]/gu) ?? []).length;
  const cyrillic = (clean.match(/[\u0400-\u04ff]/gu) ?? []).length;
  const latin = (clean.match(/[A-Za-z]/g) ?? []).length;
  const largest = Math.max(arabicScript, cjk, hangul, cyrillic, latin);
  if (largest < 12) return undefined;
  if (largest === arabicScript) return persianSpecific >= 2 ? 'fa' : 'ar';
  if (largest === cjk) return kana >= 2 ? 'ja' : 'zh';
  if (largest === hangul) return 'ko';
  if (largest === cyrillic) return 'ru';
  return 'en';
}

export function normalizeLanguage(raw: string | undefined, content?: string): string {
  const value = raw?.trim().toLowerCase().replaceAll('_', '-');
  const primary = value?.split('-')[0];
  const normalized = primary === undefined ? undefined : LANGUAGE_ALIASES[primary];
  const detected = content === undefined ? undefined : detectTextLanguage(content);
  if (normalized === undefined || normalized === 'und') return detected ?? 'und';
  // Script evidence wins over unreliable private-use and plainly wrong archive tags.
  if (detected !== undefined && detected !== normalized) return detected;
  return normalized;
}

export function normalizeStreamLanguage(stream: ProbeStream, content?: string): string {
  return normalizeLanguage(stream.tags?.language, content);
}

export function languageDisplayName(language: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}
