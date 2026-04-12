import { useState } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import './StyleSelectOverlay.css'

export function StyleSelectOverlay() {
  const t = useT()
  const presets = useGameStore((s) => s.stylePresets)
  const send = useGameStore((s) => s.send)
  const [customMode, setCustomMode] = useState(false)
  const [customTone, setCustomTone] = useState('')
  const [customNarrative, setCustomNarrative] = useState('')
  const [customArchetype, setCustomArchetype] = useState('')

  if (!presets) return null

  function handleClose() {
    useGameStore.getState().setStylePresets(null)
  }

  function selectPreset(index: number) {
    useGameStore.getState().setStylePresets(null)
    send({ type: 'select_style', preset_index: index })
  }

  function selectRandom() {
    useGameStore.getState().setStylePresets(null)
    send({ type: 'select_style', preset_index: -1 })
  }

  function submitCustom() {
    if (!customTone.trim()) return
    useGameStore.getState().setStylePresets(null)
    send({
      type: 'select_style_custom',
      tone: customTone.trim(),
      narrative_style: customNarrative.trim() || t('style.defaultNarrative'),
      player_archetype: customArchetype.trim() || t('style.defaultArchetype'),
    })
  }

  if (customMode) {
    return (
      <div className="style-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose() }}>
        <div className="style-panel">
          <div className="style-header">
            <h2 className="style-title">{t('style.customTitle')}</h2>
            <button className="style-close-btn" onClick={handleClose}>&#10005;</button>
          </div>
          <div className="custom-form">
            <label className="custom-label">
              {t('style.toneLabel')} <span className="required">*</span>
              <textarea
                className="custom-input"
                rows={2}
                placeholder={t('style.tonePlaceholder')}
                value={customTone}
                onChange={(e) => setCustomTone(e.target.value)}
              />
            </label>
            <label className="custom-label">
              {t('style.narrativeLabel')}
              <textarea
                className="custom-input"
                rows={2}
                placeholder={t('style.narrativePlaceholder')}
                value={customNarrative}
                onChange={(e) => setCustomNarrative(e.target.value)}
              />
            </label>
            <label className="custom-label">
              {t('style.archetypeLabel')}
              <textarea
                className="custom-input"
                rows={2}
                placeholder={t('style.archetypePlaceholder')}
                value={customArchetype}
                onChange={(e) => setCustomArchetype(e.target.value)}
              />
            </label>
          </div>
          <div className="style-actions">
            <button className="style-btn style-btn-back" onClick={() => setCustomMode(false)}>
              {t('style.backToPresets')}
            </button>
            <button
              className="style-btn style-btn-confirm"
              onClick={submitCustom}
              disabled={!customTone.trim()}
            >
              {t('style.startGenerate')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="style-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose() }}>
      <div className="style-panel">
        <div className="style-header">
          <h2 className="style-title">{t('style.title')}</h2>
          <button className="style-close-btn" onClick={handleClose}>&#10005;</button>
        </div>
        <div className="style-grid">
          {presets.map((p, i) => (
            <button key={i} className="style-card" onClick={() => selectPreset(i)}>
              <span className="style-card-label">{p.label}</span>
              <span className="style-card-desc">{p.description}</span>
            </button>
          ))}
        </div>
        <div className="style-actions">
          <button className="style-btn style-btn-random" onClick={selectRandom}>
            {t('style.random')}
          </button>
          <button className="style-btn style-btn-custom" onClick={() => setCustomMode(true)}>
            {t('style.custom')}
          </button>
        </div>
      </div>
    </div>
  )
}
