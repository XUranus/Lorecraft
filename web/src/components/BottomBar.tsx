import { useState, useRef, type KeyboardEvent } from 'react'
import { useGameStore } from '../stores/useGameStore'
import type { ChoiceForClient } from '../types/protocol'
import './BottomBar.css'

const DIFF_LABELS: Record<string, string> = {
  TRIVIAL: '轻松', ROUTINE: '普通', HARD: '困难', VERY_HARD: '极难', LEGENDARY: '传奇',
}

export function BottomBar() {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const send = useGameStore((s) => s.send)
  const inputEnabled = useGameStore((s) => s.inputEnabled)
  const isProcessing = useGameStore((s) => s.isProcessing)
  const insistencePrompt = useGameStore((s) => s.insistencePrompt)
  const retryable = useGameStore((s) => s.retryable)
  const location = useGameStore((s) => s.location)
  const turn = useGameStore((s) => s.turn)
  const choices = useGameStore((s) => s.choices)

  function submit() {
    const text = input.trim()
    if (!text || !inputEnabled) return

    useGameStore.getState().appendNarrative(`> ${text}`, 'player-input')
    useGameStore.getState().setChoices(null)
    send({ type: 'input', text })
    useGameStore.getState().setProcessing(true)
    useGameStore.getState().setInputEnabled(false)
    setInput('')
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function handleInsist() {
    useGameStore.getState().setInsistencePrompt(false)
    useGameStore.getState().setProcessing(true)
    useGameStore.getState().appendNarrative('> [坚持行动]', 'player-input')
    send({ type: 'insist' })
  }

  function handleAbandon() {
    useGameStore.getState().setInsistencePrompt(false)
    useGameStore.getState().setInputEnabled(true)
    send({ type: 'abandon' })
  }

  function handleRetry() {
    useGameStore.getState().setRetryable(false)
    useGameStore.getState().setProcessing(true)
    send({ type: 'retry' })
  }

  function handleSkipRetry() {
    useGameStore.getState().setRetryable(false)
    useGameStore.getState().setInputEnabled(true)
  }

  function handleSelectChoice(index: number) {
    useGameStore.getState().setProcessing(true)
    useGameStore.getState().setInputEnabled(false)
    send({ type: 'select_choice', index })
  }

  const hasChoices = choices && choices.length > 0 && inputEnabled

  return (
    <footer className="bottom-bar">
      <div className="status-bar">
        {location && <span className="status-location">{location}</span>}
        {turn > 0 && <span className="status-turn">回合 {turn}</span>}
        {isProcessing && <span className="status-processing">思考中…</span>}
      </div>
      {retryable ? (
        <div className="insistence-row">
          <span className="insistence-hint">生成出错，可能是AI输出格式异常。</span>
          <button className="insist-btn insist-confirm" onClick={handleRetry}>
            重试
          </button>
          <button className="insist-btn insist-abandon" onClick={handleSkipRetry}>
            跳过
          </button>
        </div>
      ) : insistencePrompt ? (
        <div className="insistence-row">
          <span className="insistence-hint">你的内心声音强烈不建议你这么做。</span>
          <button className="insist-btn insist-confirm" onClick={handleInsist}>
            坚持行动
          </button>
          <button className="insist-btn insist-abandon" onClick={handleAbandon}>
            改变主意
          </button>
        </div>
      ) : (
        <div className="input-zone">
          {hasChoices && (
            <div className="suggestions">
              <span className="suggestions-label">建议行动</span>
              <div className="suggestion-pills">
                {choices!.map((choice, i) => (
                  <ChoicePill key={i} choice={choice} index={i} onSelect={handleSelectChoice} />
                ))}
              </div>
            </div>
          )}
          <div className="input-row">
            <input
              ref={inputRef}
              className="input-field"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={inputEnabled ? '输入你的行动…' : '等待中…'}
              disabled={!inputEnabled}
            />
            <button
              className="send-btn"
              onClick={submit}
              disabled={!inputEnabled || !input.trim()}
            >
              发送
            </button>
          </div>
        </div>
      )}
    </footer>
  )
}

function ChoicePill({ choice, index, onSelect }: { choice: ChoiceForClient; index: number; onSelect: (i: number) => void }) {
  const check = choice.check
  return (
    <button className="suggestion-pill" onClick={() => onSelect(index)}>
      <span className="pill-key">{index === 0 ? 'A' : 'B'}</span>
      <span className="pill-body">
        {choice.text}
        {check && (
          <span className={`pill-check ${getChanceClass(check.pass_chance)}`}>
            {check.attribute_display_name} {DIFF_LABELS[check.difficulty] ?? check.difficulty} <span className="pill-chance">{check.pass_chance}%</span>
          </span>
        )}
      </span>
    </button>
  )
}

function getChanceClass(chance: number): string {
  if (chance >= 75) return 'chance-high'
  if (chance >= 40) return 'chance-mid'
  return 'chance-low'
}
