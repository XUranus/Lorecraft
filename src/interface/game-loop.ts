import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { AgentRunner } from '../ai/runner/agent-runner.js'
import { InMemoryStateStore } from '../infrastructure/storage/state-store.js'
import { InMemoryEventStore } from '../infrastructure/storage/event-store.js'
import { InMemoryLoreStore } from '../infrastructure/storage/lore-store.js'
import { InMemoryLongTermMemoryStore } from '../infrastructure/storage/long-term-memory-store.js'
import { InMemorySessionStore } from '../infrastructure/storage/session-store.js'
import { MainPipeline, PipelineExecutionError, createPipelineContext } from '../orchestration/pipeline/index.js'
import type { NarrativeOutput } from '../orchestration/pipeline/types.js'
import { InitializationAgent } from '../domain/services/initialization-agent.js'
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
  ActionValidationStep,
  ToneSignalStep,
} from '../orchestration/steps/input-steps.js'
import {
  ActiveTraitStep,
  InjectionReadStep,
  ShouldSpeakStep,
  VoiceGenerationStep,
  DebateStep,
  InsistenceStep,
  VoiceWriteStep,
} from '../orchestration/steps/reflection-steps.js'
import {
  ParallelQueryStep,
  FeasibilityCheckStep,
  AttributeCheckStep,
  ArbitrationResultStep,
} from '../orchestration/steps/arbitration-steps.js'
import type { AttributeCheckResult } from '../orchestration/steps/arbitration-steps.js'
import {
  EventContextStep,
  PacingCheckStep,
  EventGeneratorStep,
  EventSchemaValidationStep,
  EventIdStep,
  EventWriteStep,
  StateWritebackStep,
  EventBroadcastStep,
} from '../orchestration/steps/event-steps.js'
import type { ParsedIntent, InsistenceState } from '../domain/models/pipeline-io.js'
import type { GenesisDocument } from '../domain/models/genesis.js'
import type { LocationEdge } from '../domain/models/world.js'
import type { PlayerAttributes } from '../domain/models/attributes.js'
import { randomAllocate, validateAllocation, ATTRIBUTE_IDS, ATTRIBUTE_META } from '../domain/models/attributes.js'

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

export interface GameEventListener {
  onNarrative(text: string, source: string): void
  onVoices(voices: Array<{ trait_id: string; line: string }>): void
  onCheck?(check: AttributeCheckResult): void
  onInsistencePrompt?(voices: Array<{ trait_id: string; line: string }>): void
  onStatus(location: string, turn: number): void
  onError(message: string, retryable?: boolean): void
  onStyleSelect?(presets: Array<{ label: string; description: string }>): void
  onInitProgress(step: string): void
  onInitComplete(doc: GenesisDocument): void
  onCharCreate?(attributes: PlayerAttributes, meta: Array<{ id: string; display_name: string; domain: string }>): void
  onDebugTurnStart?(turn: number, input: string): void
  onDebugStep?(step: string, phase: 'start' | 'end', status?: string, duration_ms?: number, data?: string): void
  onDebugState?(states: Record<string, unknown>): void
}

// ============================================================
// GameLoop
// ============================================================

export class GameLoop {
  private stateStore: InMemoryStateStore
  private eventStore: InMemoryEventStore
  private loreStore: InMemoryLoreStore
  private longTermMemoryStore: InMemoryLongTermMemoryStore
  private sessionStore: InMemorySessionStore
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

  private gameState: GameState | null = null
  private listener: GameEventListener | null = null
  private insistenceState: InsistenceState = 'NORMAL'
  private pendingInsistInput: string | null = null
  private pendingAttributes: PlayerAttributes | null = null
  private lastInput: string | null = null
  private awaitingCharConfirm = false
  private awaitingStyleSelect = false
  private selectedStyle: StyleConfig | null = null

  constructor(provider: ILLMProvider, options?: { debug?: boolean | string }) {
    this.stateStore = new InMemoryStateStore()
    this.eventStore = new InMemoryEventStore()
    this.loreStore = new InMemoryLoreStore()
    this.longTermMemoryStore = new InMemoryLongTermMemoryStore()
    this.sessionStore = new InMemorySessionStore()
    this.injectionQueueManager = new InMemoryInjectionQueueManager()
    this.agentRunner = new AgentRunner(provider, {
      timeout_ms: 120_000,
      max_retries: 2,
      base_delay_ms: 2000,
      language: '中文',
      debug: options?.debug,
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
    this.listener?.onInitProgress(`正在生成游戏世界…`)

    const initAgent = new InitializationAgent({
      agentRunner: this.agentRunner,
      stateStore: this.stateStore,
      eventStore: this.eventStore,
      sessionStore: this.sessionStore,
      loreStore: this.loreStore,
      eventBus: this.eventBus,
      configLoader: this.configLoader,
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

      const sessionId = crypto.randomUUID()
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
      this.listener?.onError(`初始化失败: ${err instanceof Error ? err.message : String(err)}`)
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
      this.listener?.onError('当前不在角色创建阶段')
      return
    }

    const error = validateAllocation(attributes)
    if (error) {
      this.listener?.onError(`属性分配无效: ${error}`)
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

    // Now start the game proper
    this.listener?.onStatus(this.gameState.currentLocation, this.gameState.currentTurn)
    const inciting = this.gameState.genesisDoc.narrative_structure.inciting_event
    this.listener?.onNarrative(inciting.narrative_text, 'inciting_event')
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

  reset(): void {
    // Re-create all in-memory stores, wiping all state
    this.stateStore = new InMemoryStateStore()
    this.eventStore = new InMemoryEventStore()
    this.loreStore = new InMemoryLoreStore()
    this.longTermMemoryStore = new InMemoryLongTermMemoryStore()
    this.sessionStore = new InMemorySessionStore()
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

  async processInput(playerInput: string): Promise<void> {
    if (!this.gameState) {
      this.listener?.onError('游戏尚未初始化')
      return
    }

    this.agentRunner.markTurn(this.gameState.currentTurn, playerInput)

    const context = createPipelineContext(
      this.gameState.sessionId,
      this.gameState.playerCharacterId,
      this.gameState.currentTurn,
    )

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
      pipeline.addMiddleware({
        before(step_name, _input, _ctx) {
          listener?.onDebugStep?.(step_name, 'start')
        },
        after(step_name, result, _ctx, duration_ms) {
          const status = result.status
          let data: string | undefined
          try {
            if (result.status === 'continue') {
              data = JSON.stringify(result.data, null, 2)
            } else if (result.status === 'short_circuit') {
              data = JSON.stringify(result.output, null, 2)
            } else if (result.status === 'error') {
              data = JSON.stringify(result.error, null, 2)
            }
          } catch {
            data = '[unserializable]'
          }
          // Truncate very large data to avoid flooding the WS
          if (data && data.length > 4000) {
            data = data.slice(0, 4000) + '\n... [truncated]'
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
        }

        // If this was a rejection (short-circuit), write back to state for context continuity
        if (result.source === 'rejection') {
          await this.writeRejectionToState(result.text)
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
        `处理失败: ${err instanceof Error ? err.message : String(err)}`,
        retryable,
      )
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

  async save(): Promise<string> {
    if (!this.gameState) throw new Error('No game to save')
    return this.saveLoadSystem.save(
      this.gameState.genesisDoc.id,
      this.gameState.currentTurn,
    )
  }

  getGameState(): GameState | null {
    return this.gameState
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
                id: crypto.randomUUID(),
                voice_id: 'narrator',
                content: `[NPC主动行动] ${intervention.action_description}`,
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

  // ---- Pipeline Construction ----

  private buildMainPipeline(): MainPipeline {
    const pipeline = new MainPipeline()

    // Input stage
    pipeline.addStep(new ValidationStep())
    pipeline.addStep(new InputParserStep(this.agentRunner))
    pipeline.addStep(new ActionValidationStep())
    pipeline.addStep(new ToneSignalStep())

    // Reflection stage (attribute-based inner voices)
    pipeline.addStep(new ActiveTraitStep())
    pipeline.addStep(new InjectionReadStep())
    pipeline.addStep(new ShouldSpeakStep())
    pipeline.addStep(new VoiceGenerationStep(this.agentRunner))
    pipeline.addStep(new DebateStep(this.agentRunner))
    pipeline.addStep(new InsistenceStep())
    pipeline.addStep(new VoiceWriteStep())

    // Arbitration stage — feasibility + attribute check
    pipeline.addStep(new ParallelQueryStep(this.stateStore, this.loreStore, this.eventStore), (_prevOutput, ctx) => {
      const parsedIntent = ctx.data.get('parsed_intent') as ParsedIntent | undefined
      return parsedIntent?.atomic_actions?.[0] ?? _prevOutput
    })
    pipeline.addStep(new FeasibilityCheckStep(this.agentRunner))
    pipeline.addStep(new AttributeCheckStep(this.agentRunner))
    pipeline.addStep(new ArbitrationResultStep())

    // Event stage
    pipeline.addStep(new EventContextStep(this.stateStore))
    pipeline.addStep(new PacingCheckStep(this.agentRunner))
    pipeline.addStep(new EventGeneratorStep(this.agentRunner))
    pipeline.addStep(new EventSchemaValidationStep())
    pipeline.addStep(new EventIdStep())
    pipeline.addStep(new EventWriteStep(this.eventStore))
    pipeline.addStep(new StateWritebackStep(this.stateStore, this.eventStore))
    pipeline.addStep(new EventBroadcastStep())

    return pipeline
  }
}
