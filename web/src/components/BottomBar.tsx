import { useState, useRef, type KeyboardEvent } from 'react'
import { useGameStore } from '../stores/useGameStore'
import './BottomBar.css'

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

  function submit() {
    const text = input.trim()
    if (!text || !inputEnabled) return

    useGameStore.getState().appendNarrative(`> ${text}`, 'player-input')
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
      )}
    </footer>
  )
}
