import type { IStateStore } from '../../infrastructure/storage/interfaces.js'
import type { EventTier1 } from '../../domain/models/event.js'
import type { RelationshipEntry } from '../../domain/models/character.js'
import type { IInjectionQueueManager } from './injection-queue-manager.js'

// ============================================================
// PropagationEntry
// ============================================================

export interface PropagationEntry {
  event_id: string
  target_npc_id: string
  deliver_at_turn: number
  tier2_summary: string
  source_event_title: string
}

// ============================================================
// PropagationScheduler
// ============================================================

export class PropagationScheduler {
  private readonly stateStore: IStateStore
  private readonly injectionQueueManager: IInjectionQueueManager

  constructor(stateStore: IStateStore, injectionQueueManager: IInjectionQueueManager) {
    this.stateStore = stateStore
    this.injectionQueueManager = injectionQueueManager
  }

  async schedulePropagation(
    event: EventTier1,
    tier2Summary: string,
    firstBroadcastRecipients: string[],
    currentTurn: number,
  ): Promise<void> {
    // Only propagate SIGNIFICANT or MAJOR events
    if (event.weight !== 'SIGNIFICANT' && event.weight !== 'MAJOR') {
      return
    }

    const excludeSet = new Set([...firstBroadcastRecipients, ...event.participant_ids])
    const indirectTargets = new Set<string>()

    // Find indirect NPCs (relationship distance = 2)
    for (const participantId of event.participant_ids) {
      // Get direct relationships of participant
      const directRelKeys = await this.stateStore.listByPrefix(`relationship:${participantId}:`)

      for (const key of directRelKeys) {
        const rel = await this.stateStore.get<RelationshipEntry>(key)
        if (!rel) continue

        const directNpcId = rel.to_npc_id

        // Get relationships of the directly related NPC (distance 2)
        const indirectRelKeys = await this.stateStore.listByPrefix(
          `relationship:${directNpcId}:`,
        )

        for (const indirectKey of indirectRelKeys) {
          const indirectRel = await this.stateStore.get<RelationshipEntry>(indirectKey)
          if (!indirectRel) continue

          const targetId = indirectRel.to_npc_id
          if (!excludeSet.has(targetId)) {
            indirectTargets.add(targetId)
          }
        }
      }
    }

    if (indirectTargets.size === 0) return

    // Calculate delay based on weight
    const entries: PropagationEntry[] = []
    for (const targetId of indirectTargets) {
      const delay =
        event.weight === 'MAJOR'
          ? Math.floor(Math.random() * 2) // 0-1 turns
          : Math.floor(Math.random() * 2) + 1 // 1-2 turns

      entries.push({
        event_id: event.id,
        target_npc_id: targetId,
        deliver_at_turn: currentTurn + delay,
        tier2_summary: tier2Summary,
        source_event_title: event.title,
      })
    }

    // Append to existing schedule
    const existing =
      (await this.stateStore.get<PropagationEntry[]>('propagation:schedule')) ?? []
    await this.stateStore.set('propagation:schedule', [...existing, ...entries])
  }

  async processScheduledPropagations(currentTurn: number): Promise<number> {
    const schedule =
      (await this.stateStore.get<PropagationEntry[]>('propagation:schedule')) ?? []

    const due: PropagationEntry[] = []
    const remaining: PropagationEntry[] = []

    for (const entry of schedule) {
      if (entry.deliver_at_turn <= currentTurn) {
        due.push(entry)
      } else {
        remaining.push(entry)
      }
    }

    for (const entry of due) {
      this.injectionQueueManager.enqueueNPC({
        id: crypto.randomUUID(),
        npc_id: entry.target_npc_id,
        context: `你听说了：${entry.source_event_title}。${entry.tier2_summary}`,
        condition: 'propagation',
        expiry_turns: 10,
        created_at_turn: currentTurn,
      })
    }

    // Save remaining entries back
    await this.stateStore.set('propagation:schedule', remaining)

    return due.length
  }
}
