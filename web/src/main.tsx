import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { isThemeId, DEFAULT_THEME } from './theme/themes'
import { readInitialLocale } from './i18n/locales'
import './theme/global.css'
import './App.css'

// Restore saved font scale before first paint
const savedScale = localStorage.getItem('lorecraft:font-scale')
if (savedScale) {
  const root = document.getElementById('root')
  if (root) root.style.zoom = savedScale
}

// Restore saved theme before first paint (prevents FOUC)
const savedTheme = localStorage.getItem('lorecraft:theme')
document.documentElement.dataset.theme = isThemeId(savedTheme) ? savedTheme : DEFAULT_THEME

// Restore locale before first paint (detects browser language on first visit)
document.documentElement.lang = readInitialLocale()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
