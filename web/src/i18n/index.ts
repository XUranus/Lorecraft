import i18next, { type TFunction } from 'i18next'
import { useGameStore } from '../stores/useGameStore'
import { DEFAULT_LOCALE, STORAGE_KEY, isLocaleId, type LocaleId } from './locales'

// ── Eager-load all locale JSON files at build time ──
const modules = import.meta.glob('./locales/*/*.json', { eager: true }) as Record<
  string,
  { default: Record<string, string> }
>

// Build i18next resource bundles: { 'zh-CN': { ui: {...}, game: {...}, ... }, ... }
const resources: Record<string, Record<string, Record<string, string>>> = {}

for (const [path, mod] of Object.entries(modules)) {
  // path looks like './locales/zh-CN/ui.json'
  const parts = path.split('/')
  const lang = parts[2]   // 'zh-CN'
  const ns = parts[3].replace('.json', '')  // 'ui'
  if (!resources[lang]) resources[lang] = {}
  resources[lang][ns] = (mod as any).default ?? mod
}

// ── Read initial locale from localStorage ──
export function readInitialLocale(): LocaleId {
  const saved = localStorage.getItem(STORAGE_KEY)
  return isLocaleId(saved) ? saved : DEFAULT_LOCALE
}

// ── Create i18next instance (synchronous init since resources are eager-loaded) ──
const instance = i18next.createInstance()

instance.init({
  resources,
  lng: readInitialLocale(),
  fallbackLng: 'zh-CN',
  defaultNS: 'ui',
  ns: ['ui', 'game', 'config', 'charCreate'],
  interpolation: {
    escapeValue: false,  // React handles XSS
  },
})

export { instance as i18n }

/**
 * React hook that returns `i18next.t` bound to a namespace.
 * Re-renders when the Zustand `locale` changes.
 */
export function useT(ns?: string): TFunction {
  // Subscribe to locale changes so component re-renders
  useGameStore((s) => s.locale)
  return ns ? instance.getFixedT(null, ns) : instance.t.bind(instance)
}

/**
 * Non-React `t` for use in plain TS (e.g. useEngine.ts callbacks).
 * Does NOT trigger re-renders — call after `i18n.changeLanguage()`.
 */
export const t = instance.t.bind(instance)
