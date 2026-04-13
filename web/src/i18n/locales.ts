export type LocaleId = 'zh-CN' | 'en' | 'ja'

export const LOCALES: readonly LocaleId[] = ['zh-CN', 'en', 'ja'] as const

export const DEFAULT_LOCALE: LocaleId = 'en'

export const STORAGE_KEY = 'lorecraft:locale'

/** Mapping for AgentRunner's language injection field */
export const LOCALE_TO_LANGUAGE: Record<LocaleId, string> = {
  'zh-CN': '中文',
  'en': 'English',
  'ja': '日本語',
}

/** Display labels for the locale switcher (always in native script) */
export const LOCALE_LABELS: Record<LocaleId, string> = {
  'zh-CN': '中文',
  'en': 'English',
  'ja': '日本語',
}

export function isLocaleId(v: unknown): v is LocaleId {
  return v === 'zh-CN' || v === 'en' || v === 'ja'
}
