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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
