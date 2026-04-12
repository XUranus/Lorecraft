import { useState, useEffect, useRef, useCallback } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import type { DebugTurn, DebugStepEntry, DebugErrorEntry } from '../stores/useGameStore'
import { getEngine } from '../engine/bootstrap'
import { registerTab } from './registry'
import './DebugTab.css'

type DebugView = 'pipeline' | 'llm' | 'store' | 'errors'

function DebugTab() {
  const t = useT()
  const [view, setView] = useState<DebugView>('pipeline')
  const debugErrors = useGameStore((s) => s.debugErrors)

  return (
    <div className="debug-tab">
      <div className="debug-toolbar">
        <button className={`debug-toolbar-btn ${view === 'pipeline' ? 'active' : ''}`} onClick={() => setView('pipeline')}>
          {t('debug.toolbar.pipeline')}
        </button>
        <button className={`debug-toolbar-btn ${view === 'llm' ? 'active' : ''}`} onClick={() => setView('llm')}>
          {t('debug.toolbar.llmLog')}
        </button>
        <button className={`debug-toolbar-btn ${view === 'store' ? 'active' : ''}`} onClick={() => setView('store')}>
          {t('debug.toolbar.stateViewer')}
        </button>
        <button className={`debug-toolbar-btn ${view === 'errors' ? 'active' : ''}`} onClick={() => setView('errors')}>
          {t('debug.toolbar.errors')}{debugErrors.length > 0 && <span className="debug-error-badge">{debugErrors.length}</span>}
        </button>
      </div>
      <div className="debug-view-content">
        {view === 'pipeline' && <PipelineView />}
        {view === 'llm' && <LLMLogView />}
        {view === 'store' && <StoreView />}
        {view === 'errors' && <ErrorView />}
      </div>
    </div>
  )
}

// ============================================================
// 1. Pipeline View (enhanced existing view with context data)
// ============================================================

function PipelineView() {
  const t = useT()
  const initLog = useGameStore((s) => s.debugInitLog)
  const debugTurns = useGameStore((s) => s.debugTurns)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [debugTurns, initLog])

  const empty = initLog.length === 0 && debugTurns.length === 0
  // Hide InitBlock when turn 0 debug data exists (TurnBlock shows detailed LLM info)
  const hasTurn0Debug = debugTurns.some(t => t.turn === 0 && t.steps.length > 0)

  return (
    <div className="debug-pipeline-view" ref={containerRef}>
      {empty ? (
        <div className="debug-empty">{t('debug.waitingHint')}</div>
      ) : (
        <>
          {initLog.length > 0 && !hasTurn0Debug && <InitBlock log={initLog} />}
          {debugTurns.map((turn, i) => <TurnBlock key={i} turn={turn} isLast={i === debugTurns.length - 1} />)}
        </>
      )}
    </div>
  )
}

function InitBlock({ log }: { log: Array<{ message: string; timestamp: number }> }) {
  const t = useT()
  const [expanded, setExpanded] = useState(true)
  const t0 = log[0]?.timestamp ?? 0
  const tEnd = log[log.length - 1]?.timestamp ?? 0
  const totalMs = tEnd - t0

  return (
    <div className="debug-turn">
      <div className="debug-turn-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-turn-label">{t('debug.worldGen')}</span>
        <span className="debug-turn-input">{t('debug.init')}</span>
        {totalMs > 0 && <span className="debug-turn-tokens">{(totalMs / 1000).toFixed(1)}s</span>}
        <span className="debug-turn-count">{t('debug.steps', { completed: log.length, total: log.length })}</span>
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

function buildTurnReport(turn: DebugTurn, steps: GroupedStep[]): string {
  const report: Record<string, unknown> = {
    turn: turn.turn,
    input: turn.input,
    steps: steps.map((step) => {
      const entry: Record<string, unknown> = {
        name: step.name,
        status: step.status,
        duration_ms: step.duration_ms,
      }
      if (step.tokens) entry.tokens = step.tokens
      if (step.llmCalls) {
        entry.llm_calls = step.llmCalls.map((c) => ({
          agent_type: c.agent_type,
          duration_ms: c.duration_ms,
          usage: c.usage,
          messages: c.messages,
          response: c.response,
        }))
      }
      if (step.contextData) entry.context_data = step.contextData
      return entry
    }),
  }
  if (turn.states) report.states = turn.states
  return JSON.stringify(report, null, 2)
}

function TurnBlock({ turn, isLast }: { turn: DebugTurn; isLast: boolean }) {
  const t = useT()
  const [expanded, setExpanded] = useState(isLast)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (isLast) setExpanded(true)
  }, [isLast])

  const steps = groupSteps(turn.steps)
  const totalIn = steps.reduce((s, st) => s + (st.tokens?.input_tokens ?? 0), 0)
  const totalOut = steps.reduce((s, st) => s + (st.tokens?.output_tokens ?? 0), 0)
  const totalDuration = steps.reduce((s, st) => s + (st.duration_ms ?? 0), 0)

  // Pipeline progress visualization
  const completedSteps = steps.filter(s => !s.running).length
  const hasRunning = steps.some(s => s.running)

  const handleCopyReport = (e: React.MouseEvent) => {
    e.stopPropagation()
    const report = buildTurnReport(turn, steps)
    navigator.clipboard.writeText(report).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="debug-turn">
      <div className="debug-turn-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-turn-label">{t('debug.turn', { turn: turn.turn })}</span>
        <span className="debug-turn-input">{turn.input}</span>
        {totalDuration > 0 && <span className="debug-turn-duration">{(totalDuration / 1000).toFixed(1)}s</span>}
        {totalIn > 0 && (
          <span className="debug-turn-tokens">in:{totalIn} out:{totalOut}</span>
        )}
        <span className="debug-turn-count">{t('debug.steps', { completed: completedSteps, total: steps.length })}</span>
        {hasRunning && <span className="debug-turn-running">{t('debug.running')}</span>}
        {steps.length > 0 && (
          <button className="debug-turn-copy" onClick={handleCopyReport} title={t('debug.copyReport')}>
            {copied ? t('debug.copied') : t('debug.copyReport')}
          </button>
        )}
      </div>
      {expanded && (
        <div className="debug-turn-body">
          {/* Real-time pipeline progress bar */}
          {steps.length > 0 && (
            <div className="debug-pipeline-progress">
              {steps.map((step, i) => {
                const statusCls = step.running ? 'running'
                  : step.status === 'continue' ? 'ok'
                  : step.status === 'short_circuit' ? 'short-circuit'
                  : 'error'
                const widthPct = step.duration_ms && totalDuration > 0
                  ? Math.max(3, (step.duration_ms / totalDuration) * 100)
                  : step.running ? 20 : 3
                return (
                  <div
                    key={i}
                    className={`debug-progress-segment ${statusCls}`}
                    style={{ flex: `${widthPct} 0 0` }}
                    title={`${step.name}: ${step.duration_ms ?? '...'}ms`}
                  />
                )
              })}
            </div>
          )}
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

interface LLMCallInfo {
  agent_type: string
  duration_ms: number
  usage?: { input_tokens: number; output_tokens: number }
  messages: Array<{ role: string; content: string }>
  response: string
}

interface GroupedStep {
  name: string
  status: string
  duration_ms?: number
  data?: string
  tokens?: StepTokens
  llmCalls?: LLMCallInfo[]
  contextData?: Record<string, unknown>
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
      for (let i = order.length - 1; i >= 0; i--) {
        const g = map.get(order[i])
        if (g && g.name === e.step && g.running) {
          g.status = e.status ?? 'continue'
          g.duration_ms = e.duration_ms
          g.data = e.data
          if (e.data) {
            try {
              const parsed = JSON.parse(e.data)
              if (parsed.tokens) g.tokens = parsed.tokens as StepTokens
              if (parsed.llm_calls && Array.isArray(parsed.llm_calls)) {
                g.llmCalls = parsed.llm_calls as LLMCallInfo[]
              }
              if (parsed.context_data) g.contextData = parsed.context_data
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
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const hasData = !!step.data
  const hasLLM = step.llmCalls && step.llmCalls.length > 0
  const hasContext = step.contextData && Object.keys(step.contextData).length > 0

  const statusCls = step.running
    ? 'running'
    : step.status === 'continue'
      ? 'ok'
      : step.status === 'short_circuit'
        ? 'short-circuit'
        : 'error'

  return (
    <div className="debug-step">
      <div className="debug-step-header" onClick={() => (hasData || hasLLM || hasContext) && setExpanded(!expanded)}>
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
        {hasLLM && <span className="debug-step-tag llm">LLM x{step.llmCalls!.length}</span>}
        {hasContext && <span className="debug-step-tag ctx">CTX</span>}
        {step.running && <span className="debug-step-spinner">&#x27F3;</span>}
        {step.status === 'short_circuit' && <span className="debug-step-tag sc">{t('debug.shortCircuit')}</span>}
        {step.status === 'error' && <span className="debug-step-tag err">{t('debug.error')}</span>}
        {(hasData || hasLLM || hasContext) && <span className="debug-expand-hint">{expanded ? t('debug.collapse') : t('debug.expand')}</span>}
      </div>
      {expanded && (
        <div className="debug-step-body">
          {hasLLM && step.llmCalls!.map((call, i) => (
            <LLMCallCard key={i} call={call} index={i} />
          ))}
          {/* Context Data Inspector */}
          {hasContext && (
            <div className="debug-context-section">
              <div className="debug-context-header" onClick={() => setShowContext(!showContext)}>
                <span className="debug-chevron">{showContext ? '▼' : '▶'}</span>
                <span className="debug-context-label">{t('debug.contextKeys', { count: Object.keys(step.contextData!).length })}</span>
              </div>
              {showContext && (
                <div className="debug-context-body">
                  {Object.entries(step.contextData!).map(([key, value]) => (
                    <ContextKeyValue key={key} k={key} v={value} />
                  ))}
                </div>
              )}
            </div>
          )}
          {step.data && <pre className="debug-step-data">{formatStepData(step.data)}</pre>}
        </div>
      )}
    </div>
  )
}

function ContextKeyValue({ k, v }: { k: string; v: unknown }) {
  const [expanded, setExpanded] = useState(false)
  const isComplex = typeof v === 'object' && v !== null
  let preview: string
  if (typeof v === 'string') {
    preview = v.length > 80 ? v.slice(0, 80) + '...' : v
  } else if (typeof v === 'boolean' || typeof v === 'number') {
    preview = String(v)
  } else if (Array.isArray(v)) {
    preview = `Array(${v.length})`
  } else if (v === null) {
    preview = 'null'
  } else {
    preview = `{${Object.keys(v as object).length} keys}`
  }

  return (
    <div className="debug-ctx-kv">
      <div className="debug-ctx-kv-header" onClick={() => isComplex && setExpanded(!expanded)}>
        <span className="debug-ctx-key">{k}</span>
        <span className="debug-ctx-preview">{preview}</span>
        {isComplex && <span className="debug-ctx-expand">{expanded ? '▼' : '▶'}</span>}
      </div>
      {expanded && isComplex && (
        <pre className="debug-ctx-value">{JSON.stringify(v, null, 2)}</pre>
      )}
    </div>
  )
}

function formatStepData(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    const { llm_calls: _, context_data: __, ...rest } = parsed
    if (Object.keys(rest).length === 0) return ''
    return JSON.stringify(rest, null, 2)
  } catch {
    return raw
  }
}

function LLMCallCard({ call, index }: { call: LLMCallInfo; index: number }) {
  const t = useT()
  const [showInput, setShowInput] = useState(false)
  const [showOutput, setShowOutput] = useState(false)

  return (
    <div className="llm-call-card">
      <div className="llm-call-header">
        <span className="llm-call-badge">LLM #{index + 1}</span>
        <span className="llm-call-agent">{call.agent_type}</span>
        <span className="llm-call-time">{call.duration_ms}ms</span>
        {call.usage && (
          <span className="llm-call-usage">
            in:{call.usage.input_tokens} out:{call.usage.output_tokens}
          </span>
        )}
      </div>
      <div className="llm-call-actions">
        <button
          className={`llm-call-toggle ${showInput ? 'active' : ''}`}
          onClick={() => setShowInput(!showInput)}
        >
          {t('debug.llm.input', { count: call.messages.length })}
        </button>
        <button
          className={`llm-call-toggle ${showOutput ? 'active' : ''}`}
          onClick={() => setShowOutput(!showOutput)}
        >
          {t('debug.llm.output')}
        </button>
      </div>
      {showInput && (
        <div className="llm-call-messages">
          {call.messages.map((msg, i) => (
            <div key={i} className={`llm-msg llm-msg-${msg.role}`}>
              <div className="llm-msg-role">{msg.role}</div>
              <pre className="llm-msg-content">{msg.content}</pre>
            </div>
          ))}
        </div>
      )}
      {showOutput && (
        <div className="llm-call-response">
          <pre className="llm-msg-content">{formatLLMResponse(call.response)}</pre>
        </div>
      )}
    </div>
  )
}

function formatLLMResponse(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

function StateBlock({ states }: { states: Record<string, unknown> }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="debug-state-block">
      <div className="debug-state-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-state-label">{t('debug.stateSnapshot')}</span>
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

// ============================================================
// 2. LLM Log View — aggregated view of all LLM calls
// ============================================================

function LLMLogView() {
  const t = useT()
  const debugTurns = useGameStore((s) => s.debugTurns)
  const [filter, setFilter] = useState('')

  // Collect all LLM calls across all turns
  const allCalls: Array<{ turn: number; step: string; call: LLMCallInfo; index: number }> = []
  for (const turn of debugTurns) {
    const steps = groupSteps(turn.steps)
    for (const step of steps) {
      if (step.llmCalls) {
        for (let i = 0; i < step.llmCalls.length; i++) {
          allCalls.push({ turn: turn.turn, step: step.name, call: step.llmCalls[i], index: i })
        }
      }
    }
  }

  const filtered = filter
    ? allCalls.filter(c =>
        c.call.agent_type.toLowerCase().includes(filter.toLowerCase()) ||
        c.step.toLowerCase().includes(filter.toLowerCase())
      )
    : allCalls

  // Stats
  const totalCalls = allCalls.length
  const totalInputTokens = allCalls.reduce((s, c) => s + (c.call.usage?.input_tokens ?? 0), 0)
  const totalOutputTokens = allCalls.reduce((s, c) => s + (c.call.usage?.output_tokens ?? 0), 0)
  const totalDuration = allCalls.reduce((s, c) => s + c.call.duration_ms, 0)

  return (
    <div className="debug-llm-view">
      <div className="debug-llm-stats">
        <span className="debug-llm-stat">{t('debug.llm.calls', { count: totalCalls })}</span>
        <span className="debug-llm-stat">{t('debug.llm.inputTokens', { count: totalInputTokens.toLocaleString() })}</span>
        <span className="debug-llm-stat">{t('debug.llm.outputTokens', { count: totalOutputTokens.toLocaleString() })}</span>
        <span className="debug-llm-stat">{t('debug.llm.duration', { duration: (totalDuration / 1000).toFixed(1) })}</span>
      </div>
      <input
        className="debug-filter-input"
        type="text"
        placeholder={t('debug.llm.filterPlaceholder')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {filtered.length === 0 ? (
        <div className="debug-empty">{t('debug.llm.empty')}</div>
      ) : (
        <div className="debug-llm-list">
          {filtered.map((item, i) => (
            <div key={i} className="debug-llm-entry">
              <div className="debug-llm-entry-meta">
                <span className="debug-llm-entry-turn">T{item.turn}</span>
                <span className="debug-llm-entry-step">{item.step}</span>
              </div>
              <LLMCallCard call={item.call} index={item.index} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// 3. State Store Browser
// ============================================================

function StoreView() {
  const t = useT()
  const [keys, setKeys] = useState<string[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [value, setValue] = useState<string>('')
  const [prefix, setPrefix] = useState('')
  const [loading, setLoading] = useState(false)

  const loadKeys = useCallback(async () => {
    const engine = getEngine()
    if (!engine) return
    setLoading(true)
    try {
      const result = await engine.debugListStoreKeys(prefix)
      setKeys(result.sort())
    } catch (e) {
      setKeys([])
    }
    setLoading(false)
  }, [prefix])

  useEffect(() => { loadKeys() }, [loadKeys])

  const loadValue = useCallback(async (key: string) => {
    const engine = getEngine()
    if (!engine) return
    setSelectedKey(key)
    try {
      const result = await engine.debugGetStoreValue(key)
      setValue(result != null ? JSON.stringify(result, null, 2) : 'null')
    } catch (e) {
      setValue(`Error: ${e}`)
    }
  }, [])

  // Group keys by prefix (first segment)
  const groups: Record<string, string[]> = {}
  for (const key of keys) {
    const seg = key.split(':')[0]
    if (!groups[seg]) groups[seg] = []
    groups[seg].push(key)
  }

  return (
    <div className="debug-store-view">
      <div className="debug-store-toolbar">
        <input
          className="debug-filter-input"
          type="text"
          placeholder={t('debug.store.prefixPlaceholder')}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <button className="debug-store-refresh" onClick={loadKeys} disabled={loading}>
          {loading ? '...' : t('debug.store.refresh')}
        </button>
      </div>
      <div className="debug-store-layout">
        <div className="debug-store-keys">
          {keys.length === 0 ? (
            <div className="debug-empty">{t('debug.store.empty')}</div>
          ) : (
            Object.entries(groups).map(([group, groupKeys]) => (
              <StoreKeyGroup
                key={group}
                group={group}
                keys={groupKeys}
                selectedKey={selectedKey}
                onSelect={loadValue}
              />
            ))
          )}
        </div>
        <div className="debug-store-value">
          {selectedKey ? (
            <>
              <div className="debug-store-value-key">{selectedKey}</div>
              <pre className="debug-store-value-data">{value}</pre>
            </>
          ) : (
            <div className="debug-empty">{t('debug.store.selectHint')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function StoreKeyGroup({ group, keys, selectedKey, onSelect }: {
  group: string
  keys: string[]
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="debug-store-group">
      <div className="debug-store-group-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-store-group-name">{group}</span>
        <span className="debug-store-group-count">{keys.length}</span>
      </div>
      {expanded && keys.map(key => (
        <div
          key={key}
          className={`debug-store-key-item ${key === selectedKey ? 'active' : ''}`}
          onClick={() => onSelect(key)}
        >
          {key.slice(group.length + 1) || key}
        </div>
      ))}
    </div>
  )
}

// ============================================================
// 4. Error View — error replay with full context
// ============================================================

function ErrorView() {
  const t = useT()
  const debugErrors = useGameStore((s) => s.debugErrors)

  if (debugErrors.length === 0) {
    return <div className="debug-error-view"><div className="debug-empty">{t('debug.error.empty')}</div></div>
  }

  return (
    <div className="debug-error-view">
      {debugErrors.map((err, i) => (
        <ErrorEntry key={i} error={err} index={i} />
      ))}
    </div>
  )
}

function ErrorEntry({ error, index }: { error: DebugErrorEntry; index: number }) {
  const t = useT()
  const [expanded, setExpanded] = useState(index === 0)
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    const report = {
      timestamp: new Date(error.timestamp).toISOString(),
      turn: error.turn,
      input: error.input,
      step: error.step,
      error: error.error,
      context_data: error.context_data,
    }
    navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const timeStr = new Date(error.timestamp).toLocaleTimeString()

  return (
    <div className="debug-error-entry">
      <div className="debug-error-header" onClick={() => setExpanded(!expanded)}>
        <span className="debug-chevron">{expanded ? '▼' : '▶'}</span>
        <span className="debug-error-time">{timeStr}</span>
        <span className="debug-error-turn">T{error.turn}</span>
        {error.step && <span className="debug-error-step">{error.step}</span>}
        <span className="debug-error-msg">{error.error.split('\n')[0]}</span>
      </div>
      {expanded && (
        <div className="debug-error-body">
          <div className="debug-error-section">
            <div className="debug-error-section-title">{t('debug.error.input')}</div>
            <pre className="debug-error-data">{error.input}</pre>
          </div>
          <div className="debug-error-section">
            <div className="debug-error-section-title">{t('debug.error.error')}</div>
            <pre className="debug-error-data debug-error-stack">{error.error}</pre>
          </div>
          {error.context_data && Object.keys(error.context_data).length > 0 && (
            <div className="debug-error-section">
              <div className="debug-error-section-title">Pipeline Context</div>
              <pre className="debug-error-data">{JSON.stringify(error.context_data, null, 2)}</pre>
            </div>
          )}
          <button className="debug-error-copy" onClick={handleCopy}>
            {copied ? t('debug.error.copied') : t('debug.error.copyReport')}
          </button>
        </div>
      )}
    </div>
  )
}

registerTab({ id: 'debug', labelKey: 'tab.debug', component: DebugTab })
