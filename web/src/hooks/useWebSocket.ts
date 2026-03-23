import { useEffect, useRef } from 'react'
import { useGameStore } from '../stores/useGameStore'
import type { ServerMessage } from '../types/protocol'

const WS_PORT = window.__LORECRAFT_WS_PORT__ || 3015
const WS_URL = `ws://${location.hostname}:${WS_PORT}`
const RECONNECT_DELAY = 3000
const PING_INTERVAL = 30000

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const store = useGameStore

  useEffect(() => {
    let unmounted = false

    function connect() {
      if (unmounted) return
      store.getState().setConnectionStatus('connecting')

      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        store.getState().setConnectionStatus('connected')
        store.getState().setSend((msg) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg))
          }
        })
        store.getState().appendNarrative('已连接到服务器…', 'system')
        ws.send(JSON.stringify({ type: 'initialize' }))

        // Heartbeat
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, PING_INTERVAL)
      }

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerMessage
          handleMessage(msg)
        } catch (err) {
          console.error('[WS] message handling error:', err)
        }
      }

      ws.onclose = () => {
        cleanup()
        store.getState().setConnectionStatus('disconnected')
        store.getState().setInputEnabled(false)
        store.getState().setSend(() => {})
        if (!unmounted) {
          store.getState().appendNarrative('与服务器的连接已断开，正在重连…', 'error')
          setTimeout(connect, RECONNECT_DELAY)
        }
      }

      ws.onerror = () => {
        // onclose will fire
      }
    }

    function cleanup() {
      if (pingRef.current) {
        clearInterval(pingRef.current)
        pingRef.current = null
      }
    }

    function handleMessage(msg: ServerMessage) {
      if (msg.type.startsWith('debug_')) {
        console.log('[WS] debug message received:', msg.type, msg)
      }
      const s = store.getState()

      switch (msg.type) {
        case 'insistence_prompt':
          // Voices already displayed — show insistence confirmation buttons
          s.setProcessing(false)
          s.setInsistencePrompt(true)
          break

        case 'narrative': {
          const cls = msg.source === 'rejection' ? 'rejection'
            : msg.source === 'inciting_event' ? 'inciting'
            : 'event'
          const prefix = msg.source === 'rejection' ? '[旁白] '
            : msg.source === 'inciting_event' ? '[序幕] '
            : ''
          s.appendNarrative(prefix + msg.text, cls)
          if (s.isProcessing) {
            s.setProcessing(false)
            s.setInputEnabled(true)
          }
          break
        }

        case 'voices':
          s.appendVoices(msg.voices)
          // Inline voices into narrative flow
          for (const v of msg.voices) {
            s.appendNarrative(`[${v.trait_id}] ${v.line}`, 'voice')
          }
          break

        case 'check': {
          const result = msg.passed ? '成功' : '失败'
          const line = `🎲 ${msg.attribute}检定: d100(${msg.roll}) + ${msg.attribute}(${msg.attribute_value}) = ${msg.total} vs 目标${msg.target} → ${result}`
          s.appendNarrative(line, msg.passed ? 'check-pass' : 'check-fail')
          break
        }

        case 'status':
          s.setStatus(msg.location, msg.turn)
          break

        case 'error':
          s.appendNarrative(`[错误] ${msg.message}`, 'error')
          if (s.isProcessing) {
            s.setProcessing(false)
            s.setInputEnabled(true)
          }
          break

        case 'init_progress':
          s.appendNarrative(msg.step, 'system')
          break

        case 'init_complete': {
          const doc = msg.doc
          s.setInitDoc(doc)
          const ws = doc?.world_setting || {}
          const pc = doc?.characters?.player_character || {}
          s.appendNarrative('', 'spacer')
          s.appendNarrative(`═══ ${ws.tone || ''} ═══`, 'world-title')
          s.appendNarrative('', 'spacer')
          s.appendNarrative(ws.background || '', 'world-bg')
          s.appendNarrative('', 'spacer')
          s.appendNarrative(`你是 ${pc.name || ''}。${pc.background || ''}`, 'player-intro')
          s.appendNarrative('', 'spacer')
          s.appendNarrative('─────────────────────────────', 'separator')
          s.appendNarrative('', 'spacer')
          // Don't enable input yet — wait for char creation to complete
          break
        }

        case 'char_create':
          s.setCharCreate({ attributes: msg.attributes, meta: msg.attribute_meta })
          break

        case 'save_result':
          s.appendNarrative(`[系统] 存档成功: ${msg.saveId.slice(0, 8)}…`, 'system')
          break

        case 'save_error':
          s.appendNarrative(`[系统] 存档失败: ${msg.message}`, 'error')
          break

        case 'pong':
          break

        case 'debug_turn_start':
          s.debugTurnStart(msg.turn, msg.input)
          break

        case 'debug_step':
          s.debugStepEvent({
            step: msg.step,
            phase: msg.phase,
            status: msg.status,
            duration_ms: msg.duration_ms,
            data: msg.data,
            timestamp: Date.now(),
          })
          break

        case 'debug_state':
          s.debugSetState(msg.states)
          break

        case 'history': {
          // Reconnect: clear narrative and replay all history
          s.resetGame()
          for (const m of msg.messages) {
            handleMessage(m)
          }
          // Re-enable input if game was in progress
          const rs = store.getState()
          if (rs.initDoc) {
            // If game is past char creation (has turns), clear stale charCreate
            if (rs.charCreate && rs.turn > 0) {
              rs.setCharCreate(null)
            }
            if (!store.getState().charCreate && !rs.insistencePrompt) {
              store.getState().setInputEnabled(true)
            }
          }
          break
        }

        case 'reset_complete':
          s.resetGame()
          s.appendNarrative('游戏已重置。', 'system')
          // Re-initialize
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'initialize' }))
          }
          break
      }
    }

    connect()

    return () => {
      unmounted = true
      cleanup()
      wsRef.current?.close()
    }
  }, [])
}
