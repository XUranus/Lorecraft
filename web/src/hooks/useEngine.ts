import { useEffect, useRef } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { createEngine, getEngine, isLLMConfigured, setLLMConfigured } from '../engine/bootstrap'
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
import { LOCALE_TO_LANGUAGE, type LocaleId } from '../i18n/locales'
import { t, i18n } from '../i18n'

/**
 * Classify a narrative paragraph as dialogue, sound, or null (plain text)
 * based on the current locale's quotation conventions.
 *   zh-CN / ja: 「…」 dialogue, 『…』 sound
 *   en:         "…" dialogue, *…* sound
 */
function classifyParagraph(para: string): 'dialogue' | 'sound' | null {
  const lang = (i18n.language ?? 'zh-CN') as LocaleId
  if (lang === 'en') {
    if (/^".*"$/.test(para) || /^".*"$/.test(para)) return 'dialogue'
    if (/^\*.*\*$/.test(para)) return 'sound'
    if (/".*"/.test(para) || /".*"/.test(para)) return 'dialogue'
  } else {
    // zh-CN, ja — CJK quotation marks
    if (/^「.*」$/.test(para)) return 'dialogue'
    if (/^『.*』$/.test(para)) return 'sound'
    if (/「.*」/.test(para)) return 'dialogue'
  }
  return null
}

function formatCheckLine(msg: any): { line: string; style: string } {
  const diffLabel = t(`game:difficulty.${msg.difficulty}`) || msg.difficulty
  const outcomeStyle: Record<string, string> = {
    CRITICAL_SUCCESS: 'check-crit-success',
    SUCCESS: 'check-pass',
    FAILURE: 'check-fail',
    CRITICAL_FAILURE: 'check-crit-fail',
  }
  const result = msg.outcome
    ? t(`game:outcome.${msg.outcome}`)
    : (msg.passed ? t('game:outcome.SUCCESS') : t('game:outcome.FAILURE'))
  const style = msg.outcome
    ? (outcomeStyle[msg.outcome] ?? (msg.passed ? 'check-pass' : 'check-fail'))
    : (msg.passed ? 'check-pass' : 'check-fail')

  let modStr = ''
  if (msg.modifiers && msg.modifiers.length > 0) {
    const parts = msg.modifiers.map((m: any) => {
      const sign = m.value >= 0 ? '+' : ''
      return `${m.label}(${sign}${m.value})`
    })
    modStr = ` [${parts.join(', ')}]`
  }
  const targetStr = msg.modifiers && msg.modifiers.length > 0
    ? `${msg.base_target}${modStr} → ${msg.target}`
    : `${msg.target}`
  const marginStr = msg.margin != null ? ` (${msg.margin >= 0 ? '+' : ''}${msg.margin})` : ''
  const line = `\ud83c\udfb2 ${msg.attribute}[${diffLabel}]: d100(${msg.roll}) + ${msg.attribute}(${msg.attribute_value}) = ${msg.total} vs ${targetStr} \u2192 ${result}${marginStr}`
  return { line, style }
}

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

        // Sync LLM language with current locale
        const locale = store.getState().locale
        engine.setLanguage(LOCALE_TO_LANGUAGE[locale])

        // Wire up the GameEventListener
        const listener = createListener(store, sessionMessagesRef)
        engine.setListener(listener)

        store.getState().setConnectionStatus('connected')

        // Restore saved gameplay options
        const savedOpts = localStorage.getItem('lorecraft:gameplay-options')
        if (savedOpts) {
          try {
            engine.setGameplayOptions(JSON.parse(savedOpts))
            store.getState().setGameplayOptions(engine.getGameplayOptions())
          } catch { /* ignore corrupt data */ }
        }

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
            `${t('game:system.initFailed')}: ${err instanceof Error ? err.message : String(err)}`,
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
      const prefix = source === 'rejection' ? t('game:narrative.aside')
        : source === 'inciting_event' ? t('game:narrative.prologue')
        : ''

      const normalized = text.replace(/\\n/g, '\n')
      const paragraphs = normalized.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
      if (paragraphs.length <= 1) {
        s.appendNarrative(prefix + text, baseClass)
      } else {
        for (const para of paragraphs) {
          const cls = classifyParagraph(para)
          s.appendNarrative(para, cls ?? baseClass)
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
          outcome: check.outcome,
          margin: check.margin,
        }
        record(msg)
        const s = store.getState()
        const { line, style } = formatCheckLine(msg)
        s.appendNarrative(line, style)
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
      s.appendNarrative(t('game:error.generic', { message }), 'error')
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
      s.appendNarrative(t('game:narrative.playerIntro', { name: pc.name || '', background: pc.background || '' }), 'player-intro')
      s.appendNarrative('', 'spacer')
      s.appendNarrative('─────────────────────────────', 'separator')
      s.appendNarrative('', 'spacer')
    },

    onCharCreate(attributes: PlayerAttributes, meta: Array<{ id: string; display_name: string; domain: string }>) {
      record({ type: 'char_create', attributes: attributes as unknown as Record<string, number>, attribute_meta: meta })
      store.getState().setCharCreate({ attributes: attributes as unknown as Record<string, number>, meta })
    },

    onQuestUpdate(graph: import('../types/protocol').QuestGraphForClient) {
      store.getState().setQuestGraph(graph)
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

    onDebugError(errorContext: import('@engine/engine/game-loop').DebugErrorContext) {
      store.getState().debugAddError(errorContext)
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
          store.getState().appendNarrative(t('game:system.initializing'), 'system')
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
        store.getState().appendNarrative(t('game:system.noActiveGame'), 'system')
        store.getState().appendNarrative(t('game:system.noActiveGameHint'), 'system')
        break
      }

      case 'new_game':
        if (!isLLMConfigured()) {
          store.getState().appendNarrative(t('game:system.llmNotConfigured'), 'system')
          return
        }
        if (initializingRef.current) {
          store.getState().appendNarrative(t('game:system.initializingHint'), 'system')
          return
        }
        // Reset current game if one is active
        if (initializedRef.current) {
          engine.reset()
          initializedRef.current = false
          sessionMessagesRef.current = []
          store.getState().resetGame()
        }
        await engine.initialize()
        break

      case 'select_style': {
        if (!isLLMConfigured()) {
          store.getState().appendNarrative(t('game:system.llmNotConfiguredShort'), 'system')
          return
        }
        if (!engine.isAwaitingStyleSelect) {
          store.getState().appendNarrative(t('game:error.notInStyleSelect'), 'error')
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
          store.getState().appendNarrative(t('game:error.invalidPresetIndex'), 'error')
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
        if (!isLLMConfigured()) {
          store.getState().appendNarrative(t('game:system.llmNotConfiguredShort'), 'system')
          return
        }
        if (!engine.isAwaitingStyleSelect) {
          store.getState().appendNarrative(t('game:error.notInStyleSelect'), 'error')
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
          store.getState().appendNarrative(t('game:error.notInCharCreate'), 'error')
          return
        }
        engine.rerollAttributes()
        break

      case 'confirm_attributes':
        if (!engine.isAwaitingCharConfirm) {
          store.getState().appendNarrative(t('game:error.notInCharCreate'), 'error')
          return
        }
        await engine.confirmAttributes(msg.attributes as unknown as PlayerAttributes)
        initializedRef.current = true
        sessionMessagesRef.current = sessionMessagesRef.current.filter(m => m.type !== 'char_create')
        await engine.saveSessionHistory(sessionMessagesRef.current)
        break

      case 'input':
        if (!isLLMConfigured()) {
          store.getState().appendNarrative(t('game:system.llmNotConfiguredShort'), 'system')
          return
        }
        if (!initializedRef.current) {
          store.getState().appendNarrative(t('game:error.gameNotInitialized'), 'error')
          return
        }
        store.getState().setChoices(null)
        await engine.processInput(msg.text)
        await engine.saveSessionHistory(sessionMessagesRef.current)
        break

      case 'select_choice': {
        if (!isLLMConfigured()) {
          store.getState().appendNarrative(t('game:system.llmNotConfiguredShort'), 'system')
          return
        }
        if (!initializedRef.current) {
          store.getState().appendNarrative(t('game:error.gameNotInitialized'), 'error')
          return
        }
        const currentChoices = store.getState().choices
        if (!currentChoices || msg.index < 0 || msg.index >= currentChoices.length) {
          store.getState().appendNarrative(t('game:error.invalidOption'), 'error')
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
          store.getState().appendNarrative(t('game:system.saveSuccess', { id: saveId.slice(0, 8) }), 'system')
        } catch (err) {
          store.getState().appendNarrative(t('game:system.saveFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
        }
        break

      case 'reset':
        engine.reset()
        initializedRef.current = false
        initializingRef.current = false
        sessionMessagesRef.current = []
        store.getState().resetGame()
        store.getState().appendNarrative(t('game:system.gameReset'), 'system')
        // Re-initialize
        handleMessage(engine, { type: 'initialize' }, store, sessionMessagesRef, initializingRef, initializedRef)
        break

      case 'insist':
        if (!engine.isAwaitingInsist) {
          store.getState().appendNarrative(t('game:error.noPendingAction'), 'error')
          return
        }
        await engine.insist()
        break

      case 'abandon':
        if (!engine.isAwaitingInsist) return
        engine.abandon()
        store.getState().appendNarrative(t('game:system.changedMind'), 'system')
        break

      case 'retry':
        await engine.retry()
        break

      case 'get_characters': {
        const info = await engine.getCharacterInfo()
        if (info) {
          store.getState().setCharacters(info.player, info.npcs)
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
        // Directly start a new game (triggers style selection flow)
        await engine.initialize()
        break

      case 'switch_session': {
        await engine.saveSessionHistory(sessionMessagesRef.current)
        const switched = await engine.switchSession(msg.session_id)
        if (!switched) {
          store.getState().appendNarrative(t('game:error.cannotSwitchSession'), 'error')
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
            s.appendNarrative(t('game:system.loadedSession', { location: gs.currentLocation, turn: gs.currentTurn }), 'system')
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
          setLLMConfigured(true)
          store.getState().appendNarrative(t('game:system.configSaved'), 'system')
        } catch (err) {
          store.getState().appendNarrative(t('game:system.configInvalid', { message: err instanceof Error ? err.message : String(err) }), 'error')
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
          store.getState().appendNarrative(t('game:system.modelListFailed', { message: err instanceof Error ? err.message : String(err) }), 'error')
        }
        break

      case 'get_quests': {
        const questGraph = await engine.getQuestGraph()
        if (questGraph) {
          store.getState().setQuestGraph(questGraph as import('../types/protocol').QuestGraphForClient)
        }
        break
      }

      case 'get_gameplay_options':
        store.getState().setGameplayOptions(engine.getGameplayOptions())
        break

      case 'set_gameplay_options': {
        engine.setGameplayOptions(msg.options)
        const updated = engine.getGameplayOptions()
        store.getState().setGameplayOptions(updated)
        localStorage.setItem('lorecraft:gameplay-options', JSON.stringify(updated))
        break
      }
    }
  } catch (err) {
    store.getState().appendNarrative(
      t('game:error.generic', { message: err instanceof Error ? err.message : String(err) }),
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
      const prefix = msg.source === 'rejection' ? t('game:narrative.aside')
        : msg.source === 'inciting_event' ? t('game:narrative.prologue')
        : ''
      const normalized = msg.text.replace(/\\n/g, '\n')
      const paragraphs = normalized.split(/\n\n+/).map((p: string) => p.trim()).filter(Boolean)
      if (paragraphs.length <= 1) {
        s.appendNarrative(prefix + msg.text, baseClass)
      } else {
        for (const para of paragraphs) {
          const cls = classifyParagraph(para)
          s.appendNarrative(para, cls ?? baseClass)
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
      const { line, style } = formatCheckLine(msg)
      s.appendNarrative(line, style)
      break
    }
    case 'choices':
      s.setChoices(msg.choices)
      break
    case 'status':
      s.setStatus(msg.location, msg.turn)
      break
    case 'error':
      s.appendNarrative(t('game:error.generic', { message: msg.message }), 'error')
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
      s.appendNarrative(t('game:narrative.playerIntro', { name: pc.name || '', background: pc.background || '' }), 'player-intro')
      s.appendNarrative('', 'spacer')
      s.appendNarrative('─────────────────────────────', 'separator')
      s.appendNarrative('', 'spacer')
      break
    }
    case 'char_create':
      s.setCharCreate({ attributes: msg.attributes, meta: msg.attribute_meta })
      break
    case 'save_result':
      s.appendNarrative(t('game:system.saveSuccess', { id: msg.saveId.slice(0, 8) }), 'system')
      break
    case 'save_error':
      s.appendNarrative(t('game:system.saveFailed', { message: msg.message }), 'error')
      break
  }
}
