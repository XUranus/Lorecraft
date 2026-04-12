import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
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
if (savedTheme === 'parchment' || savedTheme === 'moonlight' || savedTheme === 'vellum') {
  document.documentElement.dataset.theme = savedTheme
}

// Restore saved locale before first paint
const savedLocale = localStorage.getItem('lorecraft:locale')
if (savedLocale) {
  document.documentElement.lang = savedLocale
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
