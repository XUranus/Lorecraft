import type { IStateStore } from '../../infrastructure/storage/interfaces.js'
import type { CharacterDynamicState } from '../models/character.js'
import type { NPCIntentGenerator, NPCIntentResult } from './npc-intent-generator.js'
import type { NPCTierManager } from './npc-tier-manager.js'
import type { IInjectionQueueManager } from './injection-queue-manager.js'
import type { PropagationScheduler } from './propagation-scheduler.js'
import type { DeadLetterQueue, DeadLetterEntry, EventSubscriber } from './event-bus.js'
import type { EventTier1 } from '../models/event.js'

export class AgentScheduler {
  private stateStore: IStateStore
  private intentGenerator: NPCIntentGenerator
  private tierManager: NPCTierManager
  private injectionQueueManager: IInjectionQueueManager | null
  private propagationScheduler: PropagationScheduler | null
  private deadLetterQueue: DeadLetterQueue | null
  private subscriberRegistry: Map<string, EventSubscriber> | null

  constructor(
    stateStore: IStateStore,
    intentGenerator: NPCIntentGenerator,
    tierManager: NPCTierManager,
    options?: {
      injectionQueueManager?: IInjectionQueueManager
      propagationScheduler?: PropagationScheduler
      deadLetterQueue?: DeadLetterQueue
      subscriberRegistry?: Map<string, EventSubscriber>
    },
  ) {
    this.stateStore = stateStore
    this.intentGenerator = intentGenerator
    this.tierManager = tierManager
    this.injectionQueueManager = options?.injectionQueueManager ?? null
    this.propagationScheduler = options?.propagationScheduler ?? null
    this.deadLetterQueue = options?.deadLetterQueue ?? null
    this.subscriberRegistry = options?.subscriberRegistry ?? null
  }

  /**
   * Run full end-of-turn processing. Execution order per Phase 4 spec:
   * 1. DeadLetterQueue compensation
   * 2. Propagation schedule execution
   * 3. NPC intent generation (Tier A)
   * 4. NPC tier upgrade/downgrade checks
   * 5. Injection queue expiry cleanup
   */
  async runEndOfTurn(
    current_turn: number,
    active_npc_id: string | null,
  ): Promise<NPCIntentResult[]> {
    // Step 1: DeadLetterQueue compensation
    await this.compensateDeadLetters()

    // Step 2: Process scheduled propagations
    if (this.propagationScheduler) {
      await this.propagationScheduler.processScheduledPropagations(current_turn)
    }

    // Step 3 & 4: NPC intent generation + tier checks
    const intents = await this.processNPCs(current_turn, active_npc_id)

    // Step 5: Injection queue expiry cleanup
    if (this.injectionQueueManager) {
      this.injectionQueueManager.pruneExpired(current_turn)
    }

    return intents
  }

  private async compensateDeadLetters(): Promise<void> {
    if (!this.deadLetterQueue || !this.subscriberRegistry) return

    const entries = this.deadLetterQueue.getAll()
    for (const entry of entries) {
      const subscriber = this.subscriberRegistry.get(entry.subscriber_id)
      if (!subscriber) continue

      try {
        // Reconstruct minimal EventTier1 from stateStore if possible
        const event = await this.stateStore.get<EventTier1>(
          `dead_letter:event:${entry.event_id}`,
        )
        if (event) {
          await subscriber.handle(event)
          this.deadLetterQueue.remove(entry.event_id, entry.subscriber_id)
        }
      } catch {
        // Still failing — leave in DLQ for next round
      }
    }
  }

  private async processNPCs(
    current_turn: number,
    active_npc_id: string | null,
  ): Promise<NPCIntentResult[]> {
    const npcKeys = await this.stateStore.listByPrefix('character:')
    const intents: NPCIntentResult[] = []

    const stateKeys = npcKeys.filter((k) => k.endsWith(':state'))

    for (const key of stateKeys) {
      const state = await this.stateStore.get<CharacterDynamicState>(key)
      if (!state) continue

      const npc_id = state.npc_id

      // Intent generation for Tier A NPCs
      if (
        state.tier === 'A' &&
        npc_id !== active_npc_id &&
        !state.is_active &&
        state.goal_queue.some((g) => g.status === 'IN_PROGRESS')
      ) {
        try {
          const intent = await this.intentGenerator.generateIntent(npc_id)
          intents.push(intent)
        } catch {
          // Single NPC failure should not block the loop
        }
      }

      // Check upgrade (C → B)
      await this.tierManager.checkUpgrade(npc_id)

      // Check downgrade (B → B-lite)
      await this.tierManager.checkDowngrade(npc_id, current_turn)
    }

    return intents
  }
}
