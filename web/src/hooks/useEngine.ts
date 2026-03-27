import { useEffect, useRef } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { createEngine, getEngine } from '../engine/bootstrap'
import type { GameEventListener } from '@engine/engine/game-loop'
import type { GameLoop } from '@engine/engine/game-loop'
import type { GenesisDocument } from '@engine/domain/models/genesis'
import type { PlayerAttributes } from '@engine/domain/models/attributes'
import type { AttributeCheckResult } from '@engine/orchestration/steps/arbitration-steps'
import type { ChoiceForClient } from '@engine/engine/game-loop'
import { STYLE_PRESETS } from '@engine/domain/services/extension-config'
import type { StyleConfig } from '@engine/domain/services/extension-config'
import {
  loadLLMConfig,
  saveLLMConfig,
  createProviderFromConfig,
  testLLMConnection,
  listModels,
} from '@engine/server/llm-config-browser'
import type { LLMConfig } from '@engine/server/llm-config-browser'
import type { ClientMessage } from '../types/protocol'

export function useEngine() {
  const engineRef = useRef<GameLoop | null>(null)
  const store = useGameStore
  const initializedRef = useRef(false)
  const initializingRef = useRef(false)
  const sessionMessagesRef = useRef<any[]>([])

  useEffect(() => {
    let unmounted = false

    async function boot() {
      store.getState().setConnectionStatus('connecting')

      try {
        const engine = await createEngine()
        if (unmounted) return
        engineRef.current = engine

        // Wire up the GameEventListener
        const listener = createListener(store, sessionMessagesRef)
        engine.setListener(listener)

        store.getState().setConnectionStatus('connected')

        // Set up the dispatch function so UI can send messages
        store.getState().setSend((msg: ClientMessage) => {
          handleMessage(engine, msg, store, sessionMessagesRef, initializingRef, initializedRef)
        })

        // Auto-initialize
        handleMessage(engine, { type: 'initialize' }, store, sessionMessagesRef, initializingRef, initializedRef)
      } catch (err) {
        if (!unmounted) {
          store.getState().setConnectionStatus('disconnected')
          store.getState().appendNarrative(
            `[错误] 引擎初始化失败: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          )
        }
      }
    }

    boot()

    return () => {
      unmounted = true
    }
  }, [])
}

// ============================================================
// GameEventListener → Zustand store bridge
// ============================================================

function createListener(
  store: typeof useGameStore,
  sessionMessagesRef: React.MutableRefObject<any[]>,
): GameEventListener {
  function record(msg: any) {
    const PERSIST_TYPES = new Set([
      'narrative', 'voices', 'check', 'choices', 'status', 'init_progress',
      'init_complete', 'char_create', 'error', 'save_result', 'save_error',
    ])
    if (PERSIST_TYPES.has(msg.type)) {
      sessionMessagesRef.current.push(msg)
    }
  }

  return {
    onNarrative(text: string, source: string) {
      record({ type: 'narrative', text, source })
      const s = store.getState()
      const baseClass = source === 'rejection' ? 'rejection'
        : source === 'inciting_event' ? 'inciting'
        : 'event'
      const prefix = source === 'rejection' ? '[旁白] '
        : source === 'inciting_event' ? '[序幕] '
        : ''

      const normalized = text.replace(/\\n/g, '\n')
      const paragraphs = normalized.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
      if (paragraphs.length <= 1) {
        s.appendNarrative(prefix + text, baseClass)
      } else {
        for (const para of paragraphs) {
          if (/^「.*」$/.test(para)) {
            s.appendNarrative(para, 'dialogue')
          } else if (/^『.*』$/.test(para)) {
            s.appendNarrative(para, 'sound')
          } else if (/「.*」/.test(para)) {
            s.appendNarrative(para, 'dialogue')
          } else {
            s.appendNarrative(para, baseClass)
          }
          s.appendNarrative('', 'spacer')
        }
      }
      if (s.isProcessing) {
        s.setProcessing(false)
        s.setInputEnabled(true)
      }
    },

    onVoices(voices: Array<{ trait_id: string; line: string }>) {
      record({ type: 'voices', voices })
      const s = store.getState()
      s.appendVoices(voices)
      for (const v of voices) {
        s.appendNarrative(`[${v.trait_id}] ${v.line}`, 'voice')
      }
    },

    onCheck(check: AttributeCheckResult) {
      if (check.needed && check.attribute_display_name != null) {
        const msg = {
          type: 'check' as const,
          attribute: check.attribute_display_name,
          difficulty: check.difficulty ?? 'ROUTINE',
          base_target: check.base_target ?? check.target!,
          modifiers: check.modifiers ?? [],
          target: check.target!,
          roll: check.roll!,
          attribute_value: check.attribute_value!,
          total: check.total!,
          passed: check.passed!,
        }
        record(msg)
        const s = store.getState()
        const diffLabel: Record<string, string> = { TRIVIAL: '轻松', ROUTINE: '普通', HARD: '困难', VERY_HARD: '极难', LEGENDARY: '传奇' }
        const result = msg.passed ? '成功' : '失败'
        const diff = diffLabel[msg.difficulty] ?? msg.difficulty
        let modStr = ''
        if (msg.modifiers && msg.modifiers.length > 0) {
          const parts = msg.modifiers.map((m) => {
            const sign = m.value >= 0 ? '+' : ''
            return `${m.label}(${sign}${m.value})`
          })
          modStr = ` [${parts.join(', ')}]`
        }
        const targetStr = msg.modifiers && msg.modifiers.length > 0
          ? `基础${msg.base_target}${modStr} = 目标${msg.target}`
          : `目标${msg.target}`
        const line = `🎲 ${msg.attribute}检定[${diff}]: d100(${msg.roll}) + ${msg.attribute}(${msg.attribute_value}) = ${msg.total} vs ${targetStr} → ${result}`
        s.appendNarrative(line, msg.passed ? 'check-pass' : 'check-fail')
      }
    },

    onInsistencePrompt() {
      record({ type: 'insistence_prompt' })
      const s = store.getState()
      s.setProcessing(false)
      s.setInsistencePrompt(true)
    },

    onChoices(choices: ChoiceForClient[]) {
      record({ type: 'choices', choices })
      store.getState().setChoices(choices)
    },

    onStatus(location: string, turn: number) {
      record({ type: 'status', location, turn })
      store.getState().setStatus(location, turn)
    },

    onError(message: string, retryable?: boolean) {
      record({ type: 'error', message, retryable: retryable ?? false })
      const s = store.getState()
      s.appendNarrative(`[错误] ${message}`, 'error')
      if (retryable) {
        s.setRetryable(true)
      }
      if (s.isProcessing) {
        s.setProcessing(false)
        s.setInputEnabled(!retryable)
      }
    },

    onStyleSelect(presets: Array<{ label: string; description: string }>) {
      store.getState().setStylePresets(presets)
    },

    onSessionList(sessions: Array<{ id: string; label: string; turn: number; location: string; updated_at: number }>) {
      store.getState().setSessionList(sessions)
    },

    onInitProgress(step: string) {
      record({ type: 'init_progress', step })
      const s = store.getState()
      s.appendNarrative(step, 'system')
      s.appendInitLog(step)
    },

    onInitComplete(doc: GenesisDocument) {
      record({ type: 'init_complete', doc })
      const s = store.getState()
      s.setInitDoc(doc)
      const ws = (doc as any)?.world_setting || {}
      const pc = (doc as any)?.characters?.player_character || {}
      s.appendNarrative('', 'spacer')
      s.appendNarrative(`═══ ${ws.tone || ''} ═══`, 'world-title')
      s.appendNarrative('', 'spacer')
      s.appendNarrative(ws.background || '', 'world-bg')
      s.appendNarrative('', 'spacer')
      s.appendNarrative(`你是 ${pc.name || ''}。${pc.background || ''}`, 'player-intro')
      s.appendNarrative('', 'spacer')
      s.appendNarrative('─────────────────────────────', 'separator')
      s.appendNarrative('', 'spacer')
    },

    onCharCreate(attributes: PlayerAttributes, meta: Array<{ id: string; display_name: string; domain: string }>) {
      record({ type: 'char_create', attributes: attributes as unknown as Record<string, number>, attribute_meta: meta })
      store.getState().setCharCreate({ attributes: attributes as unknown as Record<string, number>, meta })
    },

    onDebugTurnStart(turn: number, input: string) {
      store.getState().debugTurnStart(turn, input)
    },

    onDebugStep(step: string, phase: 'start' | 'end', status?: string, duration_ms?: number, data?: string) {
      store.getState().debugStepEvent({
        step, phase, status, duration_ms, data, timestamp: Date.now(),
      })
    },

    onDebugState(states: Record<string, unknown>) {
      store.getState().debugSetState(states)
    },
  }
}

// ============================================================
// Dispatch: ClientMessage → GameLoop method calls
// (Replaces game-server.ts handleMessage, without JSON serialization)
// ============================================================

async function handleMessage(
  engine: GameLoop,
  msg: ClientMessage,
  store: typeof useGameStore,
  sessionMessagesRef: React.MutableRefObject<any[]>,
  initializingRef: React.MutableRefObject<boolean>,
  initializedRef: React.MutableRefObject<boolean>,
): Promise<void> {
  try {
    switch (msg.type) {
      case 'ping':
        break

      case 'initialize': {
        if (initializedRef.current || engine.isAwaitingCharConfirm) {
          if (sessionMessagesRef.current.length > 0) {
            replayHistory(sessionMessagesRef.current, store)
          }
          if (engine.isAwaitingCharConfirm) {
            engine.rerollAttributes()
          }
          return
        }
        if (engine.isAwaitingStyleSelect) {
          store.getState().setStylePresets(
            STYLE_PRESETS.map(p => ({ label: p.label, description: p.description })),
          )
          return
        }
        if (initializingRef.current) {
          store.getState().appendNarrative('正在初始化，请稍候…', 'system')
          return
        }
        const sessions = engine.listSessions()
        if (sessions.length > 0) {
          store.getState().setSessionList(
            sessions.map(s => ({
              id: s.id, label: s.label, turn: s.turn,
              location: s.location, updated_at: s.updated_at,
            })),
          )
          return
        }
        store.getState().appendNarrative('当前没有进行中的游戏。', 'system')
        store.getState().appendNarrative('请在右上角菜单中选择「新游戏」来开始冒险。', 'system')
        break
      }

      case 'new_game':
        if (initializedRef.current || initializingRef.current) {
          store.getState().appendNarrative('[错误] 游戏已在进行中，请先重置', 'error')
          return
        }
        await engine.initialize()
        break

      case 'select_style': {
        if (!engine.isAwaitingStyleSelect) {
          store.getState().appendNarrative('[错误] 当前不在风格选择阶段', 'error')
          return
        }
        const idx = msg.preset_index
        let style: StyleConfig
        if (idx === -1) {
          const randomIdx = Math.floor(Math.random() * STYLE_PRESETS.length)
          const s = STYLE_PRESETS[randomIdx]
          style = { tone: s.tone, complexity: s.complexity, narrative_style: s.narrative_style, player_archetype: s.player_archetype }
        } else if (idx >= 0 && idx < STYLE_PRESETS.length) {
          const s = STYLE_PRESETS[idx]
          style = { tone: s.tone, complexity: s.complexity, narrative_style: s.narrative_style, player_archetype: s.player_archetype }
        } else {
          store.getState().appendNarrative('[错误] 无效的预设索引', 'error')
          return
        }
        initializingRef.current = true
        try {
          await engine.selectStyle(style)
        } finally {
          initializingRef.current = false
        }
        break
      }

      case 'select_style_custom':
        if (!engine.isAwaitingStyleSelect) {
          store.getState().appendNarrative('[错误] 当前不在风格选择阶段', 'error')
          return
        }
        initializingRef.current = true
        try {
          await engine.selectStyle({
            tone: msg.tone,
            complexity: 'MEDIUM',
            narrative_style: msg.narrative_style,
            player_archetype: msg.player_archetype,
          })
        } finally {
          initializingRef.current = false
        }
        break

      case 'reroll_attributes':
        if (!engine.isAwaitingCharConfirm) {
          store.getState().appendNarrative('[错误] 当前不在角色创建阶段', 'error')
          return
        }
        engine.rerollAttributes()
        break

      case 'confirm_attributes':
        if (!engine.isAwaitingCharConfirm) {
          store.getState().appendNarrative('[错误] 当前不在角色创建阶段', 'error')
          return
        }
        await engine.confirmAttributes(msg.attributes as unknown as PlayerAttributes)
        initializedRef.current = true
        sessionMessagesRef.current = sessionMessagesRef.current.filter(m => m.type !== 'char_create')
        await engine.saveSessionHistory(sessionMessagesRef.current)
        break

      case 'input':
        if (!initializedRef.current) {
          store.getState().appendNarrative('[错误] 游戏尚未初始化', 'error')
          return
        }
        store.getState().setChoices(null)
        await engine.processInput(msg.text)
        await engine.saveSessionHistory(sessionMessagesRef.current)
        break

      case 'select_choice': {
        if (!initializedRef.current) {
          store.getState().appendNarrative('[错误] 游戏尚未初始化', 'error')
          return
        }
        const currentChoices = store.getState().choices
        if (!currentChoices || msg.index < 0 || msg.index >= currentChoices.length) {
          store.getState().appendNarrative('[错误] 无效的选项', 'error')
          return
        }
        const selectedChoice = currentChoices[msg.index]
        store.getState().setChoices(null)
        store.getState().appendNarrative(`> ${selectedChoice.text}`, 'player-input')
        store.getState().setProcessing(true)
        store.getState().setInputEnabled(false)
        // Pass predetermined check info so AttributeCheckStep uses it directly
        const predeterminedCheck = selectedChoice.check
          ? { attribute_id: selectedChoice.check.attribute_id, difficulty: selectedChoice.check.difficulty }
          : undefined
        await engine.processInput(selectedChoice.text, { predeterminedCheck })
        await engine.saveSessionHistory(sessionMessagesRef.current)
        break
      }

      case 'save':
        try {
          const saveId = await engine.save()
          store.getState().appendNarrative(`[系统] 存档成功: ${saveId.slice(0, 8)}…`, 'system')
        } catch (err) {
          store.getState().appendNarrative(`[系统] 存档失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }
        break

      case 'reset':
        engine.reset()
        initializedRef.current = false
        initializingRef.current = false
        sessionMessagesRef.current = []
        store.getState().resetGame()
        store.getState().appendNarrative('游戏已重置。', 'system')
        // Re-initialize
        handleMessage(engine, { type: 'initialize' }, store, sessionMessagesRef, initializingRef, initializedRef)
        break

      case 'insist':
        if (!engine.isAwaitingInsist) {
          store.getState().appendNarrative('[错误] 当前没有待确认的行动', 'error')
          return
        }
        await engine.insist()
        break

      case 'abandon':
        if (!engine.isAwaitingInsist) return
        engine.abandon()
        store.getState().appendNarrative('你改变了主意。', 'system')
        break

      case 'retry':
        await engine.retry()
        break

      case 'get_characters': {
        const info = await engine.getCharacterInfo()
        if (info) {
          store.getState().setCharacters(info.player, info.npcs)
        } else {
          store.getState().appendNarrative('[错误] 游戏尚未初始化', 'error')
        }
        break
      }

      case 'list_sessions':
        store.getState().setSessionList(
          engine.listSessions().map(s => ({
            id: s.id, label: s.label, turn: s.turn,
            location: s.location, updated_at: s.updated_at,
          })),
        )
        break

      case 'new_session':
        engine.reset()
        initializedRef.current = false
        initializingRef.current = false
        sessionMessagesRef.current = []
        store.getState().resetGame()
        store.getState().appendNarrative('游戏已重置。', 'system')
        handleMessage(engine, { type: 'initialize' }, store, sessionMessagesRef, initializingRef, initializedRef)
        break

      case 'switch_session': {
        await engine.saveSessionHistory(sessionMessagesRef.current)
        const switched = await engine.switchSession(msg.session_id)
        if (!switched) {
          store.getState().appendNarrative('[错误] 无法切换到该存档', 'error')
          return
        }
        initializedRef.current = true
        initializingRef.current = false
        const gs = engine.getGameState()

        const savedHistory = await engine.loadSessionHistory(msg.session_id)
        if (savedHistory && savedHistory.length > 0) {
          sessionMessagesRef.current = savedHistory as any[]
          replayHistory(sessionMessagesRef.current, store)
        } else {
          sessionMessagesRef.current = []
          if (gs) {
            const s = store.getState()
            s.setInitDoc(gs.genesisDoc)
            s.setStatus(gs.currentLocation, gs.currentTurn)
            s.appendNarrative(`已加载存档：${gs.currentLocation}，回合 ${gs.currentTurn}`, 'system')
          }
        }
        break
      }

      case 'delete_session':
        engine.deleteSession(msg.session_id)
        store.getState().setSessionList(
          engine.listSessions().map(s => ({
            id: s.id, label: s.label, turn: s.turn,
            location: s.location, updated_at: s.updated_at,
          })),
        )
        break

      case 'get_llm_config': {
        const config = loadLLMConfig()
        if (config) {
          store.getState().setLLMConfig(config)
        } else {
          store.getState().setLLMConfig({ provider: '', api_key: '', model: '' })
        }
        break
      }

      case 'set_llm_config': {
        const newConfig: LLMConfig = {
          provider: msg.provider as any,
          api_key: msg.api_key,
          model: msg.model,
          base_url: msg.base_url,
        }
        try {
          const newProvider = createProviderFromConfig(newConfig)
          saveLLMConfig(newConfig)
          engine.setProvider(newProvider)
          store.getState().appendNarrative('[系统] 大模型配置已保存', 'system')
        } catch (err) {
          store.getState().appendNarrative(`[错误] 配置无效: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }
        break
      }

      case 'test_llm_config': {
        const testConfig: LLMConfig = {
          provider: msg.provider as any,
          api_key: msg.api_key,
          model: msg.model,
          base_url: msg.base_url,
        }
        const result = await testLLMConnection(testConfig)
        store.getState().setLLMTestResult(result)
        break
      }

      case 'list_models':
        try {
          const models = await listModels({
            provider: msg.provider as any,
            api_key: msg.api_key,
            base_url: msg.base_url,
          })
          store.getState().setLLMModels(models)
        } catch (err) {
          store.getState().appendNarrative(`[错误] 获取模型列表失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }
        break
    }
  } catch (err) {
    store.getState().appendNarrative(
      `[错误] ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  }
}

// ============================================================
// History replay (reconnect/session switch)
// ============================================================

function replayHistory(messages: any[], store: typeof useGameStore) {
  store.getState().resetGame()
  for (const msg of messages) {
    replaySingleMessage(msg, store)
  }
  const rs = store.getState()
  if (rs.initDoc) {
    if (rs.charCreate && rs.turn > 0) {
      rs.setCharCreate(null)
    }
    if (!store.getState().charCreate && !rs.insistencePrompt) {
      store.getState().setInputEnabled(true)
    }
  }
}

function replaySingleMessage(msg: any, store: typeof useGameStore) {
  const s = store.getState()
  switch (msg.type) {
    case 'narrative': {
      const baseClass = msg.source === 'rejection' ? 'rejection'
        : msg.source === 'inciting_event' ? 'inciting'
        : 'event'
      const prefix = msg.source === 'rejection' ? '[旁白] '
        : msg.source === 'inciting_event' ? '[序幕] '
        : ''
      const normalized = msg.text.replace(/\\n/g, '\n')
      const paragraphs = normalized.split(/\n\n+/).map((p: string) => p.trim()).filter(Boolean)
      if (paragraphs.length <= 1) {
        s.appendNarrative(prefix + msg.text, baseClass)
      } else {
        for (const para of paragraphs) {
          if (/^「.*」$/.test(para)) {
            s.appendNarrative(para, 'dialogue')
          } else if (/^『.*』$/.test(para)) {
            s.appendNarrative(para, 'sound')
          } else if (/「.*」/.test(para)) {
            s.appendNarrative(para, 'dialogue')
          } else {
            s.appendNarrative(para, baseClass)
          }
          s.appendNarrative('', 'spacer')
        }
      }
      if (s.isProcessing) {
        s.setProcessing(false)
        s.setInputEnabled(true)
      }
      break
    }
    case 'voices':
      s.appendVoices(msg.voices)
      for (const v of msg.voices) {
        s.appendNarrative(`[${v.trait_id}] ${v.line}`, 'voice')
      }
      break
    case 'check': {
      const diffLabel: Record<string, string> = { TRIVIAL: '轻松', ROUTINE: '普通', HARD: '困难', VERY_HARD: '极难', LEGENDARY: '传奇' }
      const result = msg.passed ? '成功' : '失败'
      const diff = diffLabel[msg.difficulty] ?? msg.difficulty
      let modStr = ''
      if (msg.modifiers && msg.modifiers.length > 0) {
        const parts = msg.modifiers.map((m: any) => {
          const sign = m.value >= 0 ? '+' : ''
          return `${m.label}(${sign}${m.value})`
        })
        modStr = ` [${parts.join(', ')}]`
      }
      const targetStr = msg.modifiers && msg.modifiers.length > 0
        ? `基础${msg.base_target}${modStr} = 目标${msg.target}`
        : `目标${msg.target}`
      const line = `🎲 ${msg.attribute}检定[${diff}]: d100(${msg.roll}) + ${msg.attribute}(${msg.attribute_value}) = ${msg.total} vs ${targetStr} → ${result}`
      s.appendNarrative(line, msg.passed ? 'check-pass' : 'check-fail')
      break
    }
    case 'choices':
      s.setChoices(msg.choices)
      break
    case 'status':
      s.setStatus(msg.location, msg.turn)
      break
    case 'error':
      s.appendNarrative(`[错误] ${msg.message}`, 'error')
      break
    case 'init_progress':
      s.appendNarrative(msg.step, 'system')
      s.appendInitLog(msg.step)
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
  }
}
