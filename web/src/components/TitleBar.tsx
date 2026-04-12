import { useState, useRef, useEffect } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import { getThemeMeta, getNextThemeId } from '../theme/themes'
import './TitleBar.css'

const THEME_GLYPH: Record<string, string> = {
  parchment: '\u25D0', // ◐
  moonlight: '\u263E', // ☾
  vellum: '\u2600',    // ☀
}

export function TitleBar() {
  const t = useT()
  const send = useGameStore((s) => s.send)
  const turn = useGameStore((s) => s.turn)
  const theme = useGameStore((s) => s.theme)
  const cycleTheme = useGameStore((s) => s.cycleTheme)
  const [confirmNew, setConfirmNew] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Cancel confirm on outside click
  useEffect(() => {
    if (!confirmNew) return
    function handleClick(e: MouseEvent) {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmNew(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [confirmNew])

  function handleSessions() {
    send({ type: 'list_sessions' })
  }

  function handleNewGame() {
    const hasActiveGame = turn > 0
    if (hasActiveGame && !confirmNew) {
      setConfirmNew(true)
      return
    }
    send({ type: 'new_game' })
    setConfirmNew(false)
  }

  const currentMeta = getThemeMeta(theme)
  const nextMeta = getThemeMeta(getNextThemeId(theme))
  const currentLabel = t(`theme.${currentMeta.id}.label`)
  const nextLabel = t(`theme.${nextMeta.id}.label`)

  return (
    <header className="title-bar">
      <span className="title-logo">&#9876; LORECRAFT</span>
      <div className="title-bar-right">
        <button
          className="titlebar-theme"
          onClick={cycleTheme}
          title={t('titlebar.themeTooltip', { current: currentLabel, next: nextLabel })}
          aria-label={t('titlebar.themeAriaLabel', { current: currentLabel })}
        >
          <span className="titlebar-theme-glyph">{THEME_GLYPH[theme] ?? '\u25D0'}</span>
        </button>
        <button className="titlebar-action" onClick={handleSessions}>
          {t('titlebar.saveManager')}
        </button>
        <button
          ref={confirmRef}
          className={`titlebar-action${confirmNew ? ' confirm' : ''}`}
          onClick={handleNewGame}
        >
          {confirmNew ? t('titlebar.confirmNewGame') : t('titlebar.newGame')}
        </button>
      </div>
    </header>
  )
}
