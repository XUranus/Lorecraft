import { useState } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import type { SessionEntry } from '../stores/useGameStore'
import './SessionOverlay.css'

function formatTime(epoch: number): string {
  const d = new Date(epoch * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function SessionOverlay() {
  const t = useT()
  const sessions = useGameStore((s) => s.sessionList)
  const send = useGameStore((s) => s.send)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  if (!sessions) return null

  function handleNew() {
    useGameStore.getState().setSessionList(null)
    send({ type: 'new_session' })
  }

  function handleSwitch(session: SessionEntry) {
    useGameStore.getState().setSessionList(null)
    send({ type: 'switch_session', session_id: session.id })
  }

  function handleDelete(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    setConfirmDelete(null)
    send({ type: 'delete_session', session_id: id })
  }

  function handleClose() {
    useGameStore.getState().setSessionList(null)
  }

  return (
    <div className="session-overlay">
      <div className="session-panel">
        <div className="session-header">
          <h2>{t('session.title')}</h2>
          <button className="session-close-btn" onClick={handleClose}>&#10005;</button>
        </div>

        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="session-empty">{t('session.empty')}</div>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="session-card" onClick={() => handleSwitch(s)}>
                <div className="session-card-main">
                  <div className="session-label">{s.label || t('session.unnamed')}</div>
                  <div className="session-meta">
                    <span>{s.location}</span>
                    <span>{t('session.turn', { turn: s.turn })}</span>
                    <span>{formatTime(s.updated_at)}</span>
                  </div>
                </div>
                <button
                  className={`session-delete-btn ${confirmDelete === s.id ? 'confirm' : ''}`}
                  onClick={(e) => { e.stopPropagation(); handleDelete(s.id) }}
                  title={t('session.delete')}
                >
                  {confirmDelete === s.id ? t('session.confirmDelete') : '\u2715'}
                </button>
              </div>
            ))
          )}
        </div>

        <button className="session-new-btn" onClick={handleNew}>
          {t('session.newGame')}
        </button>
      </div>
    </div>
  )
}
