import { useState } from 'react'
import { useGameStore } from '../stores/useGameStore'
import './StyleSelectOverlay.css'

export function StyleSelectOverlay() {
  const presets = useGameStore((s) => s.stylePresets)
  const send = useGameStore((s) => s.send)
  const [customMode, setCustomMode] = useState(false)
  const [customTone, setCustomTone] = useState('')
  const [customNarrative, setCustomNarrative] = useState('')
  const [customArchetype, setCustomArchetype] = useState('')

  if (!presets) return null

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
      narrative_style: customNarrative.trim() || '自由发挥',
      player_archetype: customArchetype.trim() || '由AI决定',
    })
  }

  if (customMode) {
    return (
      <div className="style-overlay">
        <div className="style-panel">
          <h2 className="style-title">自定义设定</h2>
          <div className="custom-form">
            <label className="custom-label">
              基调与风格 <span className="required">*</span>
              <textarea
                className="custom-input"
                rows={2}
                placeholder="例：赛博朋克世界中的底层叛逆故事"
                value={customTone}
                onChange={(e) => setCustomTone(e.target.value)}
              />
            </label>
            <label className="custom-label">
              叙事风格
              <textarea
                className="custom-input"
                rows={2}
                placeholder="例：第一人称内心独白，意识流"
                value={customNarrative}
                onChange={(e) => setCustomNarrative(e.target.value)}
              />
            </label>
            <label className="custom-label">
              主角设定
              <textarea
                className="custom-input"
                rows={2}
                placeholder="例：失忆的机械师，在废弃空间站醒来"
                value={customArchetype}
                onChange={(e) => setCustomArchetype(e.target.value)}
              />
            </label>
          </div>
          <div className="style-actions">
            <button className="style-btn style-btn-back" onClick={() => setCustomMode(false)}>
              返回预设
            </button>
            <button
              className="style-btn style-btn-confirm"
              onClick={submitCustom}
              disabled={!customTone.trim()}
            >
              开始生成
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="style-overlay">
      <div className="style-panel">
        <h2 className="style-title">选择世界风格</h2>
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
            随机选择
          </button>
          <button className="style-btn style-btn-custom" onClick={() => setCustomMode(true)}>
            自定义设定
          </button>
        </div>
      </div>
    </div>
  )
}
