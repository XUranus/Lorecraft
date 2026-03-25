import { useState, useEffect, useRef } from 'react'
import { useGameStore } from '../stores/useGameStore'
import type { DebugTurn, DebugStepEntry } from '../stores/useGameStore'
import { registerTab } from './registry'
import './DebugTab.css'

function DebugTab() {
  const initLog = useGameStore((s) => s.debugInitLog)
  const debugTurns = useGameStore((s) => s.debugTurns)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [debugTurns, initLog])

  const empty = initLog.length === 0 && debugTurns.length === 0

  return (
    <div className="debug-tab" ref={containerRef}>
      {empty ? (
        <div className="debug-empty">等待游戏开始以查看调试信息…</div>
      ) : (
        <>
          {initLog.length > 0 && <InitBlock log={initLog} />}
          {debugTurns.map((turn, i) => <TurnBlock key={i} turn={turn} isLast={i === debugTurns.length - 1} />)}
        </>
      )}
    </div>
  )
}

function InitBlock({ log }: { log: Array<{ message: string; timestamp: number }> }) {
  const [expanded, setExpanded] = useState(true)
  const t0 = log[0]?.timestamp ?? 0
  const tEnd = log[log.length - 1]?.timestamp ?? 0
  const totalMs = tEnd - t0

  return (
    <div className="debug-turn">
      <div className="debug-turn-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-turn-label">世界生成</span>
        <span className="debug-turn-input">初始化</span>
        {totalMs > 0 && <span className="debug-turn-tokens">{(totalMs / 1000).toFixed(1)}s</span>}
        <span className="debug-turn-count">{log.length} 步</span>
      </div>
      {expanded && (
        <div className="debug-turn-body">
          {log.map((entry, i) => {
            const delta = i > 0 ? entry.timestamp - log[i - 1].timestamp : 0
            return (
              <div key={i} className="debug-init-entry">
                <span className="debug-init-time">+{(delta / 1000).toFixed(1)}s</span>
                <span className="debug-init-msg">{entry.message}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TurnBlock({ turn, isLast }: { turn: DebugTurn; isLast: boolean }) {
  const [expanded, setExpanded] = useState(isLast)

  // Auto-expand the latest turn
  useEffect(() => {
    if (isLast) setExpanded(true)
  }, [isLast])

  // Group step entries into pairs (start + end)
  const steps = groupSteps(turn.steps)

  // Sum tokens across all steps
  const totalIn = steps.reduce((s, st) => s + (st.tokens?.input_tokens ?? 0), 0)
  const totalOut = steps.reduce((s, st) => s + (st.tokens?.output_tokens ?? 0), 0)

  return (
    <div className="debug-turn">
      <div className="debug-turn-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-turn-label">回合 {turn.turn}</span>
        <span className="debug-turn-input">{turn.input}</span>
        {totalIn > 0 && (
          <span className="debug-turn-tokens">in:{totalIn} out:{totalOut}</span>
        )}
        <span className="debug-turn-count">{steps.length} 步</span>
      </div>
      {expanded && (
        <div className="debug-turn-body">
          {steps.map((step, i) => (
            <StepNode key={i} step={step} />
          ))}
          {turn.states && <StateBlock states={turn.states} />}
        </div>
      )}
    </div>
  )
}

interface StepTokens {
  input_tokens: number
  output_tokens: number
  llm_calls: number
}

interface GroupedStep {
  name: string
  status: string
  duration_ms?: number
  data?: string
  tokens?: StepTokens
  running: boolean
}

function groupSteps(entries: DebugStepEntry[]): GroupedStep[] {
  const map = new Map<string, GroupedStep>()
  const order: string[] = []

  for (const e of entries) {
    if (e.phase === 'start') {
      const key = `${e.step}_${order.length}`
      map.set(key, { name: e.step, status: 'running', running: true })
      order.push(key)
    } else {
      // Find the last running entry with this step name
      for (let i = order.length - 1; i >= 0; i--) {
        const g = map.get(order[i])
        if (g && g.name === e.step && g.running) {
          g.status = e.status ?? 'continue'
          g.duration_ms = e.duration_ms
          g.data = e.data
          // Extract token info from data JSON
          if (e.data) {
            try {
              const parsed = JSON.parse(e.data)
              if (parsed.tokens) {
                g.tokens = parsed.tokens as StepTokens
              }
            } catch { /* ignore */ }
          }
          g.running = false
          break
        }
      }
    }
  }

  return order.map((k) => map.get(k)!).filter(Boolean)
}

function StepNode({ step }: { step: GroupedStep }) {
  const [expanded, setExpanded] = useState(false)
  const hasData = !!step.data

  const statusCls = step.running
    ? 'running'
    : step.status === 'continue'
      ? 'ok'
      : step.status === 'short_circuit'
        ? 'short-circuit'
        : 'error'

  return (
    <div className="debug-step">
      <div className="debug-step-header" onClick={() => hasData && setExpanded(!expanded)}>
        <span className={`debug-status-dot ${statusCls}`} />
        <span className="debug-step-name">{step.name}</span>
        {step.duration_ms != null && (
          <span className="debug-step-time">{step.duration_ms}ms</span>
        )}
        {step.tokens && (
          <span className="debug-step-tokens">
            in:{step.tokens.input_tokens} out:{step.tokens.output_tokens}
          </span>
        )}
        {step.running && <span className="debug-step-spinner">⟳</span>}
        {step.status === 'short_circuit' && <span className="debug-step-tag sc">短路</span>}
        {step.status === 'error' && <span className="debug-step-tag err">错误</span>}
        {hasData && <span className="debug-expand-hint">{expanded ? '收起' : '展开'}</span>}
      </div>
      {expanded && step.data && (
        <pre className="debug-step-data">{step.data}</pre>
      )}
    </div>
  )
}

function StateBlock({ states }: { states: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="debug-state-block">
      <div className="debug-state-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-state-label">状态快照</span>
      </div>
      {expanded && (
        <div className="debug-state-body">
          {Object.entries(states).map(([key, value]) => (
            <StateSection key={key} label={key} data={value} />
          ))}
        </div>
      )}
    </div>
  )
}

function StateSection({ label, data }: { label: string; data: unknown }) {
  const [expanded, setExpanded] = useState(false)
  let content: string
  try {
    content = JSON.stringify(data, null, 2)
  } catch {
    content = String(data)
  }

  return (
    <div className="debug-state-section">
      <div className="debug-state-section-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span>{label}</span>
      </div>
      {expanded && <pre className="debug-state-data">{content}</pre>}
    </div>
  )
}

registerTab({ id: 'debug', label: '调试', icon: '🔧', component: DebugTab })
