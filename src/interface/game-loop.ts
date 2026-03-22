import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { AgentRunner } from '../ai/runner/agent-runner.js'
import { InMemoryStateStore } from '../infrastructure/storage/state-store.js'
import { InMemoryEventStore } from '../infrastructure/storage/event-store.js'
import { InMemoryLoreStore } from '../infrastructure/storage/lore-store.js'
import { InMemoryLongTermMemoryStore } from '../infrastructure/storage/long-term-memory-store.js'
import { InMemorySessionStore } from '../infrastructure/storage/session-store.js'
import { MainPipeline, createPipelineContext } from '../orchestration/pipeline/index.js'
import type { NarrativeOutput } from '../orchestration/pipeline/types.js'
import { InitializationAgent } from '../domain/services/initialization-agent.js'
import { SaveLoadSystem } from '../domain/services/save-load-system.js'
import { ExtensionConfigLoader } from '../domain/services/extension-config.js'
import { InMemoryInjectionQueueManager } from '../domain/services/injection-queue-manager.js'
import { SignalProcessor } from '../domain/services/signal-processor.js'
import { LocationGraph } from '../domain/services/location-graph.js'
import { InsistenceStateMachine } from '../domain/services/insistence-state-machine.js'
import { EventBus, DeadLetterQueue, BroadcastRouter } from '../domain/services/event-bus.js'
import { AgentScheduler } from '../domain/services/agent-scheduler.js'
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
} from '../orchestration/steps/reflection-steps.js'
import {
  ParallelQueryStep,
  ArbitrationResultStep,
} from '../orchestration/steps/arbitration-steps.js'
import {
  EventContextStep,
  EventGeneratorStep,
  EventSchemaValidationStep,
  EventIdStep,
  EventWriteStep,
  EventBroadcastStep,
} from '../orchestration/steps/event-steps.js'
import type { GenesisDocument } from '../domain/models/genesis.js'
import type { LocationEdge } from '../domain/models/world.js'

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
  onStatus(location: string, turn: number): void
  onError(message: string): void
  onInitProgress(step: string): void
  onInitComplete(doc: GenesisDocument): void
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
  private configLoader: ExtensionConfigLoader
  private saveLoadSystem: SaveLoadSystem

  private gameState: GameState | null = null
  private listener: GameEventListener | null = null

  constructor(provider: ILLMProvider) {
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
    })
    this.signalProcessor = new SignalProcessor(this.stateStore, [])
    this.locationGraph = new LocationGraph([])
    this.insistenceSM = new InsistenceStateMachine()
    this.deadLetterQueue = new DeadLetterQueue()
    this.eventBus = new EventBus(this.deadLetterQueue)
    this.broadcastRouter = new BroadcastRouter(this.stateStore)
    this.configLoader = new ExtensionConfigLoader()

    const intentGenerator = new NPCIntentGenerator(this.agentRunner, this.stateStore)
    const tierManager = new NPCTierManager(this.stateStore)
    this.agentScheduler = new AgentScheduler(this.stateStore, intentGenerator, tierManager, {
      injectionQueueManager: this.injectionQueueManager,
      deadLetterQueue: this.deadLetterQueue,
    })

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
    this.listener?.onInitProgress('正在生成游戏世界…')

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
      this.listener?.onStatus(startLocation, 1)

      // Show inciting event narrative
      const inciting = doc.narrative_structure.inciting_event
      this.listener?.onNarrative(inciting.narrative_text, 'inciting_event')
    } catch (err) {
      this.listener?.onError(`初始化失败: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  async processInput(playerInput: string): Promise<void> {
    if (!this.gameState) {
      this.listener?.onError('游戏尚未初始化')
      return
    }

    const context = createPipelineContext(
      this.gameState.sessionId,
      this.gameState.playerCharacterId,
      this.gameState.currentTurn,
    )

    try {
      // Build and run the full pipeline
      const pipeline = this.buildMainPipeline()
      const result = await pipeline.execute(playerInput, context)

      if (result) {
        this.listener?.onNarrative(result.text, result.source)
      }

      // Check for voice lines in context
      const voices = context.data.get('voice_lines') as
        | Array<{ trait_id: string; line: string }>
        | undefined
      if (voices && voices.length > 0) {
        this.listener?.onVoices(voices)
      }

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

      // End-of-turn async processing
      await this.agentScheduler.runEndOfTurn(this.gameState.currentTurn, null)
    } catch (err) {
      this.listener?.onError(
        `处理失败: ${err instanceof Error ? err.message : String(err)}`,
      )
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

  // ---- Pipeline Construction ----

  private buildMainPipeline(): MainPipeline {
    const pipeline = new MainPipeline()

    // Input stage
    pipeline.addStep(new ValidationStep())
    pipeline.addStep(new InputParserStep(this.agentRunner))
    pipeline.addStep(new ActionValidationStep())
    pipeline.addStep(new ToneSignalStep())

    // Reflection stage (simplified)
    pipeline.addStep(new ActiveTraitStep(this.signalProcessor))

    // Arbitration stage (simplified — query + result)
    pipeline.addStep(new ParallelQueryStep(this.stateStore), (prevOutput) => {
      // Extract first atomic action from the parsed intent
      const actions = prevOutput?.atomic_actions ?? [prevOutput]
      return Array.isArray(actions) ? actions[0] : actions
    })
    pipeline.addStep(new ArbitrationResultStep())

    // Event stage
    pipeline.addStep(new EventContextStep(this.stateStore))
    pipeline.addStep(new EventGeneratorStep(this.agentRunner))
    pipeline.addStep(new EventSchemaValidationStep())
    pipeline.addStep(new EventIdStep())
    pipeline.addStep(new EventWriteStep(this.eventStore))
    pipeline.addStep(new EventBroadcastStep())

    return pipeline
  }
}
