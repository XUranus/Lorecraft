import { useState } from 'react'
import { useGameStore } from '../stores/useGameStore'
import type { SessionEntry } from '../stores/useGameStore'
import './SessionOverlay.css'

function formatTime(epoch: number): string {
  const d = new Date(epoch * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function SessionOverlay() {
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
          <h2>存档管理</h2>
          <button className="session-close-btn" onClick={handleClose}>&#10005;</button>
        </div>

        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="session-empty">暂无存档</div>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="session-card" onClick={() => handleSwitch(s)}>
                <div className="session-card-main">
                  <div className="session-label">{s.label || '未命名'}</div>
                  <div className="session-meta">
                    <span>{s.location}</span>
                    <span>回合 {s.turn}</span>
                    <span>{formatTime(s.updated_at)}</span>
                  </div>
                </div>
                <button
                  className={`session-delete-btn ${confirmDelete === s.id ? 'confirm' : ''}`}
                  onClick={(e) => { e.stopPropagation(); handleDelete(s.id) }}
                  title="删除"
                >
                  {confirmDelete === s.id ? '确认？' : '\u2715'}
                </button>
              </div>
            ))
          )}
        </div>

        <button className="session-new-btn" onClick={handleNew}>
          + 新游戏
        </button>
      </div>
    </div>
  )
}
