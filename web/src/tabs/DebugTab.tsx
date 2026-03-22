import { useState, useEffect, useRef } from 'react'
import { useGameStore } from '../stores/useGameStore'
import type { DebugTurn, DebugStepEntry } from '../stores/useGameStore'
import { registerTab } from './registry'
import './DebugTab.css'

function DebugTab() {
  const debugTurns = useGameStore((s) => s.debugTurns)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [debugTurns])

  return (
    <div className="debug-tab" ref={containerRef}>
      {debugTurns.length === 0 ? (
        <div className="debug-empty">等待输入以查看 Pipeline 调试信息…</div>
      ) : (
        debugTurns.map((turn, i) => <TurnBlock key={i} turn={turn} isLast={i === debugTurns.length - 1} />)
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

  return (
    <div className="debug-turn">
      <div className="debug-turn-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-turn-label">回合 {turn.turn}</span>
        <span className="debug-turn-input">{turn.input}</span>
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

interface GroupedStep {
  name: string
  status: string
  duration_ms?: number
  data?: string
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
