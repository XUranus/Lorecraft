import { useState, useRef, useEffect } from 'react'
import { useGameStore } from '../stores/useGameStore'
import './TitleBar.css'

export function TitleBar() {
  const status = useGameStore((s) => s.connectionStatus)
  const send = useGameStore((s) => s.send)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setConfirmReset(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  function handleReset() {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    send({ type: 'reset' })
    setMenuOpen(false)
    setConfirmReset(false)
  }

  function handleSave() {
    send({ type: 'save' })
    setMenuOpen(false)
  }

  function handleSessions() {
    send({ type: 'list_sessions' })
    setMenuOpen(false)
  }

  function handleSettings() {
    send({ type: 'get_llm_config' })
    useGameStore.getState().setSettingsOpen(true)
    setMenuOpen(false)
  }

  return (
    <header className="title-bar">
      <span className="title-logo">&#9876; LORECRAFT</span>
      <div className="title-bar-right">
        <div className="settings-wrapper" ref={menuRef}>
          <button
            className="settings-btn"
            onClick={() => { setMenuOpen(!menuOpen); setConfirmReset(false) }}
            title="设置"
          >
            &#9881;
          </button>
          {menuOpen && (
            <div className="settings-menu">
              <button className="menu-item" onClick={handleSave}>
                存档
              </button>
              <button className="menu-item" onClick={handleSessions}>
                存档管理
              </button>
              <button className="menu-item" onClick={handleSettings}>
                设置
              </button>
              <button className="menu-item danger" onClick={handleReset}>
                {confirmReset ? '确认重置？' : '重置游戏'}
              </button>
            </div>
          )}
        </div>
        <span className={`conn-dot ${status}`} title={status} />
      </div>
    </header>
  )
}
