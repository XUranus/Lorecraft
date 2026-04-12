import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { AgentRunner } from '../ai/runner/agent-runner.js'
import type { IDebugLogger } from '../ai/runner/debug-logger.js'
import type { IStoreFactory, SessionInfo } from '../infrastructure/storage/store-factory.js'
import type { IStateStore, IEventStore, ILoreStore, ILongTermMemoryStore, ISessionStore } from '../infrastructure/storage/interfaces.js'
import { MainPipeline, PipelineExecutionError, createPipelineContext } from '../orchestration/pipeline/index.js'
import type { NarrativeOutput, GameplayOptions } from '../orchestration/pipeline/types.js'
import { DEFAULT_GAMEPLAY_OPTIONS } from '../orchestration/pipeline/types.js'
import { InitializationAgent, type ProgressMessage } from '../domain/services/initialization-agent.js'
import { SaveLoadSystem } from '../domain/services/save-load-system.js'
import { ExtensionConfigLoader, STYLE_PRESETS, type StyleConfig } from '../domain/services/extension-config.js'
import { InMemoryInjectionQueueManager } from '../domain/services/injection-queue-manager.js'
import { SignalProcessor } from '../domain/services/signal-processor.js'
import { LocationGraph } from '../domain/services/location-graph.js'
import { InsistenceStateMachine } from '../domain/services/insistence-state-machine.js'
import { EventBus, DeadLetterQueue, BroadcastRouter } from '../domain/services/event-bus.js'
import { AgentScheduler } from '../domain/services/agent-scheduler.js'
import { NarrativeRailAgent } from '../domain/services/narrative-rail-agent.js'
import { NPCTierManager } from '../domain/services/npc-tier-manager.js'
import { NPCIntentGenerator } from '../domain/services/npc-intent-generator.js'
import {
  ValidationStep,
  InputParserStep,
  WorldAssertionFilterStep,
  ActionValidationStep,
  ToneSignalStep,
} from '../orchestration/steps/input-steps.js'
import {
  ActiveTraitStep,
  InjectionReadStep,
  ShouldSpeakStep,
  VoiceDebateStep,
  InsistenceStep,
  VoiceWriteStep,
} from '../orchestration/steps/reflection-steps.js'
import {
  FullContextStep,
  ActionArbiterStep,
  ArbitrationResultStep,
} from '../orchestration/steps/arbitration-steps.js'
import type { AttributeCheckResult } from '../orchestration/steps/arbitration-steps.js'
import {
  PacingStep,
  EventGeneratorStep,
  EventSchemaValidationStep,
  EventIdStep,
  EventWriteStep,
  StateWritebackStep,
  NarrativeProgressStep,
  EventBroadcastStep,
} from '../orchestration/steps/event-steps.js'
import { QuestTrackingStep } from '../orchestration/steps/quest-steps.js'
import type { QuestGraph } from '../domain/models/quest.js'
import type { ParsedIntent, InsistenceState, ChoiceOption } from '../domain/models/pipeline-io.js'
import type { GenesisDocument } from '../domain/models/genesis.js'
import type { LocationEdge } from '../domain/models/world.js'
import type { PlayerAttributes } from '../domain/models/attributes.js'
import { randomAllocate, validateAllocation, ATTRIBUTE_IDS, ATTRIBUTE_META, type PlayerAttributes as PlayerAttrs } from '../domain/models/attributes.js'
import { uuid } from '../utils/uuid.js'

// ============================================================
// Game State
// ============================================================

export interface GameState {
  genesisDoc: GenesisDocument
  currentTurn: number
  playerCharacterId: string
  sessionId: string
  currentLocation: string
}

// ============================================================
// TUI Event Emitter
// ============================================================

export interface ChoiceForClient {
  text: string
  check?: {
    attribute_id: string
    attribute_display_name: string
    difficulty: string
    pass_chance: number
  }
}

export interface GameEventListener {
  onNarrative(text: string, source: string): void
  onVoices(voices: Array<{ trait_id: string; line: string }>): void
  onCheck?(check: AttributeCheckResult): void
  onInsistencePrompt?(voices: Array<{ trait_id: string; line: string }>): void
  onChoices?(choices: ChoiceForClient[]): void
  onStatus(location: string, turn: number): void
  onError(message: string, retryable?: boolean): void
  onStyleSelect?(presets: Array<{ label: string; description: string }>): void
  onSessionList?(sessions: Array<{ id: string; label: string; turn: number; location: string; updated_at: number }>): void
  onInitProgress(step: string | ProgressMessage): void
  onInitComplete(doc: GenesisDocument): void
  onCharCreate?(attributes: PlayerAttributes, meta: Array<{ id: string; display_name: string; domain: string }>): void
  onDebugTurnStart?(turn: number, input: string): void
  onQuestUpdate?(graph: QuestGraph): void
  onDebugStep?(step: string, phase: 'start' | 'end', status?: string, duration_ms?: number, data?: string): void
  onDebugState?(states: Record<string, unknown>): void
  onDebugError?(errorContext: DebugErrorContext): void
}

export interface DebugErrorContext {
  turn: number
  input: string
  error: string
  step?: string
  context_data?: Record<string, unknown>
  timestamp: number
}

// ============================================================
// GameLoop
// ============================================================

export class GameLoop {
  private store: IStoreFactory
  private stateStore: IStateStore
  private eventStore: IEventStore
  private loreStore: ILoreStore
  private longTermMemoryStore: ILongTermMemoryStore
  private sessionStore: ISessionStore
  private injectionQueueManager: InMemoryInjectionQueueManager
  private agentRunner: AgentRunner
  private signalProcessor: SignalProcessor
  private locationGraph: LocationGraph
  private insistenceSM: InsistenceStateMachine
  private eventBus: EventBus
  private deadLetterQueue: DeadLetterQueue
  private broadcastRouter: BroadcastRouter
  private agentScheduler: AgentScheduler
  private narrativeRailAgent: NarrativeRailAgent
  private configLoader: ExtensionConfigLoader
  private saveLoadSystem: SaveLoadSystem

  private gameplayOptions: GameplayOptions = { ...DEFAULT_GAMEPLAY_OPTIONS }
  private gameState: GameState | null = null
  private listener: GameEventListener | null = null
  private insistenceState: InsistenceState = 'NORMAL'
  private pendingInsistInput: string | null = null
  private pendingAttributes: PlayerAttributes | null = null
  private lastInput: string | null = null
  private awaitingCharConfirm = false
  private awaitingStyleSelect = false
  private selectedStyle: StyleConfig | null = null

  constructor(store: IStoreFactory, provider: ILLMProvider, options?: { debugLogger?: IDebugLogger }) {
    this.store = store
    this.stateStore = store.stateStore
    this.eventStore = store.eventStore
    this.loreStore = store.loreStore
    this.longTermMemoryStore = store.longTermMemoryStore
    this.sessionStore = store.sessionStore
    this.injectionQueueManager = new InMemoryInjectionQueueManager()
    this.agentRunner = new AgentRunner(provider, {
      timeout_ms: 120_000,
      max_retries: 2,
      base_delay_ms: 2000,
      language: undefined,
      debugLogger: options?.debugLogger,
    })
    this.configLoader = new ExtensionConfigLoader()
    this.signalProcessor = new SignalProcessor(this.stateStore, this.configLoader.getTraitConfigs())
    this.locationGraph = new LocationGraph([])
    this.insistenceSM = new InsistenceStateMachine()
    this.deadLetterQueue = new DeadLetterQueue()
    this.eventBus = new EventBus(this.deadLetterQueue)
    this.broadcastRouter = new BroadcastRouter(this.stateStore)

    const intentGenerator = new NPCIntentGenerator(this.agentRunner, this.stateStore)
    const tierManager = new NPCTierManager(this.stateStore)
    this.agentScheduler = new AgentScheduler(this.stateStore, intentGenerator, tierManager, {
      injectionQueueManager: this.injectionQueueManager,
      deadLetterQueue: this.deadLetterQueue,
    })
    this.narrativeRailAgent = new NarrativeRailAgent(this.agentRunner, this.eventStore, this.stateStore)

    this.saveLoadSystem = new SaveLoadSystem(
      this.stateStore,
      this.eventStore,
      this.sessionStore,
      this.longTermMemoryStore,
      this.injectionQueueManager,
    )
  }

  setListener(listener: GameEventListener): void {
    this.listener = listener
  }

  /** Hot-swap the LLM provider at runtime */
  setProvider(provider: ILLMProvider): void {
    this.agentRunner.setProvider(provider)
  }

  /** Change the language injected into LLM prompts at runtime */
  setLanguage(lang: string): void {
    this.agentRunner.setLanguage(lang)
  }

  getGameplayOptions(): GameplayOptions {
    return { ...this.gameplayOptions }
  }

  setGameplayOptions(opts: Partial<GameplayOptions>): void {
    Object.assign(this.gameplayOptions, opts)
  }

  async initialize(): Promise<void> {
    // Send style presets to client and wait for selection
    this.awaitingStyleSelect = true
    this.listener?.onStyleSelect?.(
      STYLE_PRESETS.map((p) => ({ label: p.label, description: p.description })),
    )
  }

  get isAwaitingStyleSelect(): boolean {
    return this.awaitingStyleSelect
  }

  /** Called when the user picks a preset or provides custom style */
  async selectStyle(style: StyleConfig): Promise<void> {
    this.awaitingStyleSelect = false
    this.selectedStyle = style
    await this.generateWorld()
  }

  private async generateWorld(): Promise<void> {
    if (!this.selectedStyle) return
    this.agentRunner.markTurn(0, '[INITIALIZATION]')

    this.configLoader = new ExtensionConfigLoader({ style: this.selectedStyle })
    this.listener?.onInitProgress({ key: 'init.generatingWorld' })

    // Emit debug turn 0 for world generation
    this.listener?.onDebugTurnStart?.(0, '[World Generation]')
    const stepTimers = new Map<string, number>()
    const runner = this.agentRunner
    const listener = this.listener

    const initAgent = new InitializationAgent({
      agentRunner: this.agentRunner,
      stateStore: this.stateStore,
      eventStore: this.eventStore,
      sessionStore: this.sessionStore,
      loreStore: this.loreStore,
      eventBus: this.eventBus,
      configLoader: this.configLoader,
      onProgress: (msg) => this.listener?.onInitProgress(msg),
      onStep: (name, phase) => {
        if (phase === 'start') {
          runner.drainUsage()
          runner.drainCalls()
          stepTimers.set(name, performance.now())
          listener?.onDebugStep?.(name, 'start')
        } else {
          const startTime = stepTimers.get(name) ?? performance.now()
          const duration_ms = Math.round((performance.now() - startTime) * 100) / 100
          const stepUsage = runner.drainUsage()
          const stepCalls = runner.drainCalls()

          let data: string | undefined
          try {
            const payload: Record<string, unknown> = {}
            if (stepUsage.length > 0) {
              payload.tokens = {
                input_tokens: stepUsage.reduce((s, u) => s + u.input_tokens, 0),
                output_tokens: stepUsage.reduce((s, u) => s + u.output_tokens, 0),
                llm_calls: stepUsage.length,
              }
            }
            if (stepCalls.length > 0) {
              payload.llm_calls = stepCalls.map((c) => ({
                agent_type: c.agent_type,
                duration_ms: c.duration_ms,
                usage: c.usage,
                messages: c.messages.map((m) => ({
                  role: m.role,
                  content: m.content.length > 3000
                    ? m.content.slice(0, 3000) + '\n... [truncated]'
                    : m.content,
                })),
                response: c.response.length > 5000
                  ? c.response.slice(0, 5000) + '\n... [truncated]'
                  : c.response,
              }))
            }
            data = JSON.stringify(payload, null, 2)
            if (data && data.length > 30000) {
              data = data.slice(0, 30000) + '\n... [truncated]'
            }
          } catch {
            data = '[unserializable]'
          }
          listener?.onDebugStep?.(name, 'end', 'continue', duration_ms, data)
        }
      },
    })

    try {
      const doc = await initAgent.initialize()

      // Load location graph from generated edges
      const edges = await this.stateStore.get<LocationEdge[]>('world:location_edges')
      if (edges) {
        this.locationGraph = new LocationGraph(edges)
      }

      // Seed initial trait weights so the reflection system starts active
      for (const traitConfig of this.configLoader.getTraitConfigs()) {
        await this.stateStore.set(`player:traits:${traitConfig.trait_id}`, {
          trait_id: traitConfig.trait_id,
          trait_type: traitConfig.trait_type,
          current_weight: traitConfig.threshold_active + 0.1,
          last_updated_turn: 0,
        })
      }

      const sessionId = uuid()
      const startLocation = doc.initial_locations[0]?.id ?? 'unknown'

      this.gameState = {
        genesisDoc: doc,
        currentTurn: 1,
        playerCharacterId: doc.characters.player_character.id,
        sessionId,
        currentLocation: startLocation,
      }

      this.listener?.onInitComplete(doc)

      // Enter character creation phase: send random attributes
      this.pendingAttributes = randomAllocate()
      this.awaitingCharConfirm = true
      const meta = ATTRIBUTE_IDS.map((id) => ({
        id,
        display_name: ATTRIBUTE_META[id].display_name,
        domain: ATTRIBUTE_META[id].domain,
      }))
      this.listener?.onCharCreate?.(this.pendingAttributes, meta)
    } catch (err) {
      this.listener?.onError(`Initialization failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  rerollAttributes(): void {
    if (!this.awaitingCharConfirm) return
    this.pendingAttributes = randomAllocate()
    const meta = ATTRIBUTE_IDS.map((id) => ({
      id,
      display_name: ATTRIBUTE_META[id].display_name,
      domain: ATTRIBUTE_META[id].domain,
    }))
    this.listener?.onCharCreate?.(this.pendingAttributes, meta)
  }

  async confirmAttributes(attributes: PlayerAttributes): Promise<void> {
    if (!this.awaitingCharConfirm || !this.gameState) {
      this.listener?.onError('Not in character creation phase')
      return
    }

    const error = validateAllocation(attributes)
    if (error) {
      this.listener?.onError(`Invalid attribute allocation: ${error}`)
      return
    }

    // Persist attributes
    await this.stateStore.set(
      `player:attributes:${this.gameState.playerCharacterId}`,
      attributes,
    )

    // Store on genesis doc for reference
    this.gameState.genesisDoc.characters.player_character.attributes = attributes

    this.awaitingCharConfirm = false
    this.pendingAttributes = null

    // Create a session record
    const worldSetting = this.gameState.genesisDoc.world_setting
    const label = worldSetting?.tone ?? 'Unnamed World'
    this.store.createSession(
      this.gameState.sessionId,
      this.gameState.genesisDoc.id,
      label,
    )
    this.store.updateSession(this.gameState.sessionId, {
      location: this.gameState.currentLocation,
    })

    // Initialize empty quest graph — quests emerge organically via QuestTrackingStep
    const initialGraph: QuestGraph = { quests: [], nodes: [], edges: [] }
    await this.stateStore.set('quests:graph', initialGraph)

    // Now start the game proper
    this.listener?.onStatus(this.gameState.currentLocation, this.gameState.currentTurn)
    const inciting = this.gameState.genesisDoc.narrative_structure.inciting_event
    this.listener?.onNarrative(inciting.narrative_text, 'inciting_event')

    // Send initial quest graph
    this.listener?.onQuestUpdate?.(initialGraph)
  }

  get isAwaitingCharConfirm(): boolean {
    return this.awaitingCharConfirm
  }

  get isAwaitingInsist(): boolean {
    return this.pendingInsistInput !== null
  }

  /** Player insists on the action that triggered voice warnings */
  async insist(): Promise<void> {
    const input = this.pendingInsistInput
    if (!input) return
    this.pendingInsistInput = null
    // insistenceState is already WARNED from the short-circuit, so re-running
    // the same input will proceed with force_flag=true
    await this.processInput(input)
  }

  /** Player abandons the action */
  abandon(): void {
    this.pendingInsistInput = null
    this.insistenceState = 'NORMAL'
  }

  /** Clear runtime state only — database is untouched, existing sessions preserved. */
  resetRuntime(): void {
    this.injectionQueueManager = new InMemoryInjectionQueueManager()
    this.signalProcessor = new SignalProcessor(this.stateStore, this.configLoader.getTraitConfigs())
    this.locationGraph = new LocationGraph([])
    this.insistenceSM = new InsistenceStateMachine()
    this.deadLetterQueue = new DeadLetterQueue()
    this.eventBus = new EventBus(this.deadLetterQueue)
    this.broadcastRouter = new BroadcastRouter(this.stateStore)

    const intentGenerator = new NPCIntentGenerator(this.agentRunner, this.stateStore)
    const tierManager = new NPCTierManager(this.stateStore)
    this.agentScheduler = new AgentScheduler(this.stateStore, intentGenerator, tierManager, {
      injectionQueueManager: this.injectionQueueManager,
      deadLetterQueue: this.deadLetterQueue,
    })
    this.narrativeRailAgent = new NarrativeRailAgent(this.agentRunner, this.eventStore, this.stateStore)
    this.saveLoadSystem = new SaveLoadSystem(
      this.stateStore,
      this.eventStore,
      this.sessionStore,
      this.longTermMemoryStore,
      this.injectionQueueManager,
    )

    this.gameState = null
    this.insistenceState = 'NORMAL'
    this.pendingInsistInput = null
    this.pendingAttributes = null
    this.awaitingCharConfirm = false
    this.awaitingStyleSelect = false
    this.selectedStyle = null
  }

  /** Wipe ALL data (all sessions, all tables) and reset runtime. */
  reset(): void {
    this.store.resetAll()
    this.stateStore = this.store.stateStore
    this.eventStore = this.store.eventStore
    this.loreStore = this.store.loreStore
    this.longTermMemoryStore = this.store.longTermMemoryStore
    this.sessionStore = this.store.sessionStore
    this.resetRuntime()
  }

  async processInput(playerInput: string, options?: { predeterminedCheck?: { attribute_id: string; difficulty: string } }): Promise<void> {
    if (!this.gameState) {
      this.listener?.onError('Game not initialized')
      return
    }

    this.agentRunner.markTurn(this.gameState.currentTurn, playerInput)

    const context = createPipelineContext(
      this.gameState.sessionId,
      this.gameState.playerCharacterId,
      this.gameState.currentTurn,
      this.gameplayOptions,
    )

    // Inject predetermined check from choice selection (bypasses check_dm LLM call)
    if (options?.predeterminedCheck) {
      context.data.set('predetermined_check', options.predeterminedCheck)
    }

    let lastStepName: string | undefined

    // Emit debug turn start
    this.listener?.onDebugTurnStart?.(this.gameState.currentTurn, playerInput)

    try {
      // Pre-load context for pipeline steps
      const subjectiveMemory = await this.stateStore.get<unknown>(
        `memory:subjective:${this.gameState.playerCharacterId}`,
      )
      if (subjectiveMemory) {
        context.data.set('recent_context', subjectiveMemory)
      }

      // Store original player text for downstream steps
      context.data.set('original_text', playerInput)

      // Inject persisted insistence state
      context.data.set('insistence_state', this.insistenceState)

      // Inject queued reflections from narrative rail into pipeline
      const queuedReflection = this.injectionQueueManager.dequeueReflection()
      if (queuedReflection) {
        context.data.set('injection_queue', [queuedReflection.content])
      }

      // Inject player attributes for voices and checks
      const playerAttrs = await this.stateStore.get<PlayerAttributes>(
        `player:attributes:${this.gameState.playerCharacterId}`,
      )
      if (playerAttrs) {
        context.data.set('player_attributes', playerAttrs)
      }

      // Build and run the full pipeline
      const pipeline = this.buildMainPipeline()

      // Attach streaming debug middleware
      const listener = this.listener
      const runner = this.agentRunner
      pipeline.addMiddleware({
        before(step_name, _input, _ctx) {
          // Drain any pending usage/calls so we only capture this step's calls
          runner.drainUsage()
          runner.drainCalls()
          lastStepName = step_name
          listener?.onDebugStep?.(step_name, 'start')
        },
        after(step_name, result, ctx, duration_ms) {
          lastStepName = step_name
          const status = result.status
          // Collect token usage for LLM calls made during this step
          const stepUsage = runner.drainUsage()
          const stepCalls = runner.drainCalls()
          const tokenInfo = stepUsage.length > 0
            ? {
                input_tokens: stepUsage.reduce((s, u) => s + u.input_tokens, 0),
                output_tokens: stepUsage.reduce((s, u) => s + u.output_tokens, 0),
                llm_calls: stepUsage.length,
              }
            : undefined

          let data: string | undefined
          try {
            const payload: Record<string, unknown> = {}
            if (tokenInfo) {
              payload.tokens = tokenInfo
            }
            if (result.status === 'continue') {
              payload.result = result.data
            } else if (result.status === 'short_circuit') {
              payload.result = result.output
            } else if (result.status === 'error') {
              payload.result = result.error
            }
            // Include LLM call details (summarized to avoid huge payloads)
            if (stepCalls.length > 0) {
              payload.llm_calls = stepCalls.map((c) => ({
                agent_type: c.agent_type,
                duration_ms: c.duration_ms,
                usage: c.usage,
                messages: c.messages.map((m) => ({
                  role: m.role,
                  content: m.content.length > 3000
                    ? m.content.slice(0, 3000) + '\n... [truncated]'
                    : m.content,
                })),
                response: c.response.length > 3000
                  ? c.response.slice(0, 3000) + '\n... [truncated]'
                  : c.response,
              }))
            }
            // Snapshot pipeline context.data after this step
            const contextSnapshot: Record<string, unknown> = {}
            for (const [k, v] of ctx.data.entries()) {
              try {
                // Only include serializable values, skip functions
                if (typeof v !== 'function') {
                  contextSnapshot[k] = v
                }
              } catch { /* skip unserializable */ }
            }
            if (Object.keys(contextSnapshot).length > 0) {
              payload.context_data = contextSnapshot
            }
            data = JSON.stringify(payload, null, 2)
          } catch {
            data = '[unserializable]'
          }
          // Truncate very large data to avoid flooding
          if (data && data.length > 30000) {
            data = data.slice(0, 30000) + '\n... [truncated]'
          }
          listener?.onDebugStep?.(step_name, 'end', status, Math.round(duration_ms * 100) / 100, data)
        },
      })

      const result = await pipeline.execute(playerInput, context)

      // Send voices BEFORE narrative — inner thoughts precede the action
      if (result) {
        if (result.source === 'reflection') {
          // Reflection short-circuit: voices warn the player, prompt to insist or abandon
          const reflectionOutput = context.data.get('reflection_output') as
            | { voices: Array<{ trait_id: string; line: string }> }
            | undefined
          const voices = reflectionOutput?.voices ?? []
          if (voices.length) {
            this.listener?.onVoices(voices)
          }
          this.pendingInsistInput = playerInput
          this.listener?.onInsistencePrompt?.(voices)
        } else {
          // Normal flow: voices first, then check, then narrative
          const voices = context.data.get('voice_lines') as
            | Array<{ trait_id: string; line: string }>
            | undefined
          if (voices && voices.length > 0) {
            this.listener?.onVoices(voices)
          }

          // Send attribute check result if one occurred
          const check = context.data.get('attribute_check') as AttributeCheckResult | undefined
          if (check?.needed) {
            this.listener?.onCheck?.(check)
          }

          this.listener?.onNarrative(result.text, result.source)

          // Send choices if available
          const rawChoices = context.data.get('raw_choices') as ChoiceOption[] | undefined
          if (rawChoices && rawChoices.length > 0 && playerAttrs) {
            const enriched = this.gameplayOptions.action_arbiter
              ? this.enrichChoices(rawChoices, playerAttrs as PlayerAttrs)
              : rawChoices.map((c) => ({ text: c.text }))
            this.listener?.onChoices?.(enriched)
          }
        }

        // If this was a rejection (short-circuit), write back to state for context continuity
        if (result.source === 'rejection') {
          await this.writeRejectionToState(result.text)
        }

        // Send quest graph update if available
        const questGraph = context.data.get('quest_graph') as QuestGraph | undefined
        if (questGraph) {
          this.listener?.onQuestUpdate?.(questGraph)
        }
      }

      // Persist insistence state across turns
      this.insistenceState = (context.data.get('insistence_state') as InsistenceState) ?? 'NORMAL'

      // Persist drift_flag for NarrativeRailAgent
      const driftFlag = (context.data.get('drift_flag') as boolean | undefined) ?? false
      await this.stateStore.set('pipeline:drift_flag', driftFlag)

      // Update game state
      this.gameState.currentTurn++

      // Update location if changed
      const newLocation = await this.stateStore.get<string>(
        `character:location:${this.gameState.playerCharacterId}`,
      )
      if (newLocation) {
        this.gameState.currentLocation = newLocation
      }

      this.listener?.onStatus(this.gameState.currentLocation, this.gameState.currentTurn)

      // Update session record
      this.store.updateSession(this.gameState.sessionId, {
        turn: this.gameState.currentTurn,
        location: this.gameState.currentLocation,
      })

      // Emit debug state snapshot
      this.listener?.onDebugState?.(await this.collectDebugState())

      // End-of-turn async processing
      await this.agentScheduler.runEndOfTurn(this.gameState.currentTurn, null)

      // Narrative rail: assess drift and inject corrections
      await this.runNarrativeRailCheck()
    } catch (err) {
      const retryable = err instanceof PipelineExecutionError &&
        (err.code === 'PARSE_FAILED' || err.code === 'LLM_CALL_FAILED')
      if (retryable) {
        this.lastInput = playerInput
      }
      this.listener?.onError(
        `Processing failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable,
      )
      // Emit debug error context for error replay
      const contextSnapshot: Record<string, unknown> = {}
      for (const [k, v] of context.data.entries()) {
        try { if (typeof v !== 'function') contextSnapshot[k] = v } catch { /* skip */ }
      }
      this.listener?.onDebugError?.({
        turn: this.gameState?.currentTurn ?? 0,
        input: playerInput,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
        step: lastStepName,
        context_data: contextSnapshot,
        timestamp: Date.now(),
      })
    }
  }

  /** Retry the last failed input */
  async retry(): Promise<void> {
    const input = this.lastInput
    if (!input) return
    this.lastInput = null
    await this.processInput(input)
  }

  private async collectDebugState(): Promise<Record<string, unknown>> {
    if (!this.gameState) return {}
    const pid = this.gameState.playerCharacterId
    const [subjectiveMemory, objectiveState, traitWeights, playerAttributes] = await Promise.all([
      this.stateStore.get<unknown>(`memory:subjective:${pid}`),
      this.stateStore.get<unknown>(`world:objective:${pid}`),
      Promise.all(
        this.configLoader.getTraitConfigs().map(async (c) => ({
          trait_id: c.trait_id,
          ...(await this.stateStore.get<Record<string, unknown>>(`player:traits:${c.trait_id}`)),
        })),
      ),
      this.stateStore.get<unknown>(`player:attributes:${pid}`),
    ])
    return {
      game: {
        turn: this.gameState.currentTurn,
        location: this.gameState.currentLocation,
        session: this.gameState.sessionId,
      },
      attributes: playerAttributes,
      traits: traitWeights,
      subjective_memory: subjectiveMemory,
      objective_state: objectiveState,
    }
  }

  /** Debug: list all keys in the state store */
  async debugListStoreKeys(prefix = ''): Promise<string[]> {
    return this.stateStore.listByPrefix(prefix)
  }

  /** Debug: get a value from the state store */
  async debugGetStoreValue(key: string): Promise<unknown> {
    return this.stateStore.get(key)
  }

  async save(): Promise<string> {
    if (!this.gameState) throw new Error('No game to save')
    return this.saveLoadSystem.save(
      this.gameState.genesisDoc.id,
      this.gameState.currentTurn,
    )
  }

  /** Persist message history for the current session */
  async saveSessionHistory(history: unknown[]): Promise<void> {
    if (!this.gameState) return
    await this.stateStore.set(`session:${this.gameState.sessionId}:history`, history)
  }

  /** Load message history for a given session */
  async loadSessionHistory(sessionId: string): Promise<unknown[] | null> {
    return this.stateStore.get<unknown[]>(`session:${sessionId}:history`)
  }

  getGameState(): GameState | null {
    return this.gameState
  }

  /** Gather all character info the player currently knows about */
  async getCharacterInfo(): Promise<{ player: any; npcs: any[] } | null> {
    if (!this.gameState) return null
    const doc = this.gameState.genesisDoc
    const playerId = this.gameState.playerCharacterId
    const pc = doc.characters.player_character

    // Player info
    const playerAttrs = await this.stateStore.get<Record<string, number>>(
      `player:attributes:${playerId}`,
    )
    const playerInfo = {
      id: pc.id,
      name: pc.name,
      background: pc.background,
      attributes: playerAttrs,
    }

    // NPC info: only what the player has encountered (player:knowledge:*)
    const knowledgeKeys = await this.stateStore.listByPrefix('player:knowledge:')
    const npcs: any[] = []
    for (const key of knowledgeKeys) {
      const k = await this.stateStore.get<import('../domain/models/character.js').CharacterKnowledge>(key)
      if (k) {
        npcs.push({
          id: k.npc_id,
          name: k.name,
          first_impression: k.first_impression,
          known_facts: k.known_facts,
          relationship_to_player: k.relationship_to_player,
          last_seen_location: k.last_seen_location,
          last_seen_emotion: k.last_seen_emotion,
          last_interaction_turn: k.last_interaction_turn,
        })
      }
    }

    return { player: playerInfo, npcs }
  }

  /** Get current quest graph from state store */
  async getQuestGraph(): Promise<QuestGraph | null> {
    return this.stateStore.get<QuestGraph>('quests:graph')
  }

  // ---- Narrative Rail Check ----

  private async runNarrativeRailCheck(): Promise<void> {
    if (!this.gameState) return

    // Get current narrative phase
    const phaseIndex = await this.stateStore.get<number>('narrative:current_phase_index') ?? 0
    const phases = await this.stateStore.get<Array<{ phase_id: string; description: string; direction_summary: string }>>('narrative:phases')
    if (!phases || phases.length === 0) return

    const currentPhase = phases[Math.min(phaseIndex, phases.length - 1)]
    const currentTurn = this.gameState.currentTurn

    try {
      const assessment = await this.narrativeRailAgent.assessDrift(currentPhase, currentTurn)

      if (assessment.needs_intervention) {
        const intervention = await this.narrativeRailAgent.generateIntervention(
          assessment,
          currentPhase,
          currentTurn,
          this.gameState.playerCharacterId,
        )

        if (intervention) {
          switch (intervention.type) {
            case 'reflection':
              this.injectionQueueManager.enqueueReflection(intervention.injection)
              break
            case 'npc':
              this.injectionQueueManager.enqueueNPC(intervention.injection)
              break
            case 'npc_action':
              // Level 3: also inject as high-priority reflection so it flows
              // through the full pipeline on the next turn (context, voices, event generation)
              this.injectionQueueManager.enqueueReflection({
                id: uuid(),
                voice_id: 'narrator',
                content: `[NPC Action] ${intervention.action_description}`,
                priority: 'HIGH',
                expiry_turns: 3,
                created_at_turn: currentTurn,
              })
              break
          }
        }
      } else {
        // No drift — if we had previous interventions, mark them as effective
        if (this.narrativeRailAgent.getLastInterventionLevel() > 0) {
          this.narrativeRailAgent.recordInterventionEffect(true)
        }
      }
    } catch (err) {
      // Narrative rail failure should not block the game
      console.error('[NarrativeRail] drift check failed:', err)
    }
  }

  // ---- Rejection State Writeback ----

  private async writeRejectionToState(rejectionText: string): Promise<void> {
    if (!this.gameState) return
    const playerId = this.gameState.playerCharacterId

    const prevMemory = await this.stateStore.get<{
      recent_narrative: string[]
      known_facts: string[]
      known_characters: string[]
    }>(`memory:subjective:${playerId}`)

    const recentNarrative = prevMemory?.recent_narrative ?? []
    recentNarrative.push(rejectionText)
    if (recentNarrative.length > 20) {
      recentNarrative.splice(0, recentNarrative.length - 20)
    }

    await this.stateStore.set(`memory:subjective:${playerId}`, {
      recent_narrative: recentNarrative,
      known_facts: prevMemory?.known_facts ?? [],
      known_characters: prevMemory?.known_characters ?? [],
    })
  }

  // ---- Choice Enrichment ----

  private enrichChoices(rawChoices: ChoiceOption[], attrs: PlayerAttrs): ChoiceForClient[] {
    const DIFFICULTY_MIDPOINTS: Record<string, number> = {
      TRIVIAL: 50, ROUTINE: 80, HARD: 110, VERY_HARD: 140, LEGENDARY: 170,
    }

    return rawChoices.map((c) => {
      if (!c.check) return { text: c.text }

      const attrId = c.check.attribute_id as keyof typeof ATTRIBUTE_META
      const meta = ATTRIBUTE_META[attrId as typeof ATTRIBUTE_IDS[number]]
      if (!meta) return { text: c.text }

      const attrValue = attrs[attrId] ?? 0
      const target = DIFFICULTY_MIDPOINTS[c.check.difficulty] ?? 80
      // d100 ranges 1-100: pass when roll + attrValue >= target
      // P(pass) = P(roll >= target - attrValue) = max(0, min(100, 101 - target + attrValue))
      const passChance = Math.max(0, Math.min(100, 101 - target + attrValue))

      return {
        text: c.text,
        check: {
          attribute_id: c.check.attribute_id,
          attribute_display_name: meta.display_name,
          difficulty: c.check.difficulty,
          pass_chance: Math.round(passChance),
        },
      }
    })
  }

  // ---- Pipeline Construction ----

  private buildMainPipeline(): MainPipeline {
    const pipeline = new MainPipeline()

    // Input stage
    pipeline.addStep(new ValidationStep())
    pipeline.addStep(new InputParserStep(this.agentRunner))
    pipeline.addStep(new WorldAssertionFilterStep())
    pipeline.addStep(new ActionValidationStep())
    pipeline.addStep(new ToneSignalStep())

    // Reflection stage (attribute-based inner voices)
    pipeline.addStep(new ActiveTraitStep())
    pipeline.addStep(new InjectionReadStep())
    pipeline.addStep(new ShouldSpeakStep())
    pipeline.addStep(new VoiceDebateStep(this.agentRunner))
    pipeline.addStep(new InsistenceStep())
    pipeline.addStep(new VoiceWriteStep())

    // Arbitration stage — full context fetch + unified feasibility/check
    pipeline.addStep(new FullContextStep(this.stateStore, this.loreStore, this.eventStore), (_prevOutput, ctx) => {
      const parsedIntent = ctx.data.get('parsed_intent') as ParsedIntent | undefined
      return parsedIntent?.atomic_actions?.[0] ?? _prevOutput
    })
    pipeline.addStep(new ActionArbiterStep(this.agentRunner))
    pipeline.addStep(new ArbitrationResultStep())

    // Event stage
    pipeline.addStep(new PacingStep())
    pipeline.addStep(new EventGeneratorStep(this.agentRunner))
    pipeline.addStep(new EventSchemaValidationStep())
    pipeline.addStep(new EventIdStep())
    pipeline.addStep(new EventWriteStep(this.eventStore))
    pipeline.addStep(new StateWritebackStep(this.stateStore, this.eventStore))
    pipeline.addStep(new QuestTrackingStep(this.agentRunner, this.stateStore))
    pipeline.addStep(new NarrativeProgressStep(this.agentRunner, this.stateStore))
    pipeline.addStep(new EventBroadcastStep())

    return pipeline
  }

  // ---- Session Management ----

  listSessions(): SessionInfo[] {
    return this.store.listSessions()
  }

  /** Check if there's an active session that can be resumed */
  getActiveSession(): SessionInfo | null {
    return this.store.getActiveSession()
  }

  /** Resume an existing session by loading its genesis doc and state */
  async switchSession(sessionId: string): Promise<boolean> {
    const sessions = this.store.listSessions()
    const target = sessions.find((s) => s.id === sessionId)
    if (!target) return false

    // Load genesis doc
    const doc = await this.sessionStore.loadGenesis(target.genesis_id)
    if (!doc) return false

    // Activate session
    this.store.activateSession(sessionId)

    // Rebuild game state
    this.gameState = {
      genesisDoc: doc,
      currentTurn: target.turn,
      playerCharacterId: doc.characters.player_character.id,
      sessionId: target.id,
      currentLocation: target.location,
    }

    // Load player attributes
    const attrs = await this.stateStore.get<PlayerAttributes>(
      `player:attributes:${this.gameState.playerCharacterId}`,
    )
    if (attrs) {
      this.gameState.genesisDoc.characters.player_character.attributes = attrs
    }

    // Load location graph
    const edges = await this.stateStore.get<LocationEdge[]>('world:location_edges')
    if (edges) {
      this.locationGraph = new LocationGraph(edges)
    }

    // Reset runtime state
    this.insistenceState = 'NORMAL'
    this.pendingInsistInput = null
    this.awaitingCharConfirm = false
    this.awaitingStyleSelect = false

    // Send quest graph if available
    const questGraph = await this.stateStore.get<QuestGraph>('quests:graph')
    if (questGraph) {
      this.listener?.onQuestUpdate?.(questGraph)
    }

    return true
  }

  deleteSession(sessionId: string): void {
    this.store.deleteSession(sessionId)
    // If we deleted the active session, clear game state
    if (this.gameState?.sessionId === sessionId) {
      this.gameState = null
    }
  }
}
