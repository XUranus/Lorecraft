import { useState, useEffect, useCallback } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import type { CharCreateState } from '../stores/useGameStore'
import './CharCreateOverlay.css'

const ATTRIBUTE_TOTAL = 400

function getTier(value: number): number {
  if (value <= 10) return 0
  if (value <= 30) return 1
  if (value <= 60) return 2
  if (value <= 90) return 3
  return 4
}

function getTierColor(tier: number): string {
  switch (tier) {
    case 0: return 'tier-0'
    case 1: return 'tier-1'
    case 2: return 'tier-2'
    case 3: return 'tier-3'
    case 4: return 'tier-4'
    default: return 'tier-2'
  }
}

// ============================================================
// Components
// ============================================================

export function CharCreateOverlay() {
  const charCreate = useGameStore((s) => s.charCreate)
  const send = useGameStore((s) => s.send)

  if (!charCreate) return null

  return <CharCreatePanel charCreate={charCreate} send={send} />
}

function CharCreatePanel({
  charCreate,
  send,
}: {
  charCreate: CharCreateState
  send: ReturnType<typeof useGameStore.getState>['send']
}) {
  const t = useT('charCreate')
  const [attrs, setAttrs] = useState<Record<string, number>>({ ...charCreate.attributes })
  const [error, setError] = useState<string | null>(null)

  // Sync when server sends new random attributes (reroll)
  useEffect(() => {
    setAttrs({ ...charCreate.attributes })
    setError(null)
  }, [charCreate.attributes])

  const total = Object.values(attrs).reduce((a, b) => a + b, 0)
  const remaining = ATTRIBUTE_TOTAL - total

  const setAttr = useCallback((id: string, value: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)))
    setAttrs((prev) => ({ ...prev, [id]: clamped }))
    setError(null)
  }, [])

  function handleReroll() {
    send({ type: 'reroll_attributes' })
  }

  function handleConfirm() {
    const sum = Object.values(attrs).reduce((a, b) => a + b, 0)
    if (sum !== ATTRIBUTE_TOTAL) {
      setError(t('errorTotal', { sum, required: ATTRIBUTE_TOTAL }))
      return
    }
    for (const m of charCreate.meta) {
      const v = attrs[m.id]
      if (v === undefined || v < 0 || v > 100 || !Number.isInteger(v)) {
        setError(t('errorInvalid', { name: m.display_name }))
        return
      }
    }
    send({ type: 'confirm_attributes', attributes: attrs })
    useGameStore.getState().setCharCreate(null)
    useGameStore.getState().setInputEnabled(true)
  }

  return (
    <div className="char-create-overlay">
      <div className="char-create-panel">
        <h2 className="char-create-title">{t('title')}</h2>
        <p className="char-create-subtitle">{t('subtitle', { total: ATTRIBUTE_TOTAL })}</p>

        <div className="attr-list">
          {charCreate.meta.map((m) => (
            <AttrRow
              key={m.id}
              id={m.id}
              displayName={m.display_name}
              value={attrs[m.id] ?? 0}
              onChange={setAttr}
            />
          ))}
        </div>

        <div className={`attr-remaining ${remaining === 0 ? 'ok' : remaining < 0 ? 'over' : 'under'}`}>
          {remaining === 0
            ? t('allAllocated')
            : remaining > 0
              ? t('remaining', { count: remaining })
              : t('exceeded', { count: -remaining })}
        </div>

        {error && <div className="char-create-error">{error}</div>}

        <div className="char-create-actions">
          <button className="action-btn secondary" onClick={handleReroll}>
            {t('reroll')}
          </button>
          <button
            className="action-btn primary"
            onClick={handleConfirm}
            disabled={remaining !== 0}
          >
            {t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

function AttrRow({
  id,
  displayName,
  value,
  onChange,
}: {
  id: string
  displayName: string
  value: number
  onChange: (id: string, v: number) => void
}) {
  const t = useT('charCreate')
  const tier = getTier(value)
  const label = t(`${id}.${tier}.label`)
  const text = t(`${id}.${tier}.text`)

  return (
    <div className="attr-row">
      <div className="attr-header">
        <span className="attr-name">{displayName}</span>
        <span className={`attr-tier-label ${getTierColor(tier)}`}>{label}</span>
        <input
          className="attr-input"
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(id, parseInt(e.target.value) || 0)}
        />
      </div>
      <div className="attr-slider-row">
        <input
          className={`attr-slider ${getTierColor(tier)}`}
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(id, parseInt(e.target.value))}
        />
      </div>
      <div className={`attr-desc ${getTierColor(tier)}`}>{text}</div>
    </div>
  )
}
