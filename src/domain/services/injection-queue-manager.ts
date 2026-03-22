import type { ReflectionInjection, NPCInjection } from '../../domain/models/injection.js'

// ============================================================
// IInjectionQueueManager
// ============================================================

export interface IInjectionQueueManager {
  enqueueReflection(injection: ReflectionInjection): void
  enqueueNPC(injection: NPCInjection): void
  dequeueReflection(): ReflectionInjection | null
  dequeueNPC(npc_id: string): NPCInjection | null
  peekReflections(): ReflectionInjection[]
  peekNPCInjections(npc_id: string): NPCInjection[]
  pruneExpired(current_turn: number): void
}

// ============================================================
// InMemoryInjectionQueueManager
// ============================================================

export class InMemoryInjectionQueueManager implements IInjectionQueueManager {
  private reflectionQueue: ReflectionInjection[] = []
  private npcQueue: Map<string, NPCInjection[]> = new Map()

  enqueueReflection(injection: ReflectionInjection): void {
    this.reflectionQueue.push(injection)
    this.sortReflectionQueue()
  }

  enqueueNPC(injection: NPCInjection): void {
    const queue = this.npcQueue.get(injection.npc_id)
    if (queue) {
      queue.push(injection)
    } else {
      this.npcQueue.set(injection.npc_id, [injection])
    }
  }

  dequeueReflection(): ReflectionInjection | null {
    if (this.reflectionQueue.length === 0) return null
    return this.reflectionQueue.shift()!
  }

  dequeueNPC(npc_id: string): NPCInjection | null {
    const queue = this.npcQueue.get(npc_id)
    if (!queue || queue.length === 0) return null

    if (queue.length === 1) {
      const item = queue[0]
      this.npcQueue.delete(npc_id)
      return item
    }

    // Merge all injections for this NPC
    const merged = this.mergeNPCInjections(queue)
    this.npcQueue.delete(npc_id)
    return merged
  }

  peekReflections(): ReflectionInjection[] {
    return [...this.reflectionQueue]
  }

  peekNPCInjections(npc_id: string): NPCInjection[] {
    const queue = this.npcQueue.get(npc_id)
    return queue ? [...queue] : []
  }

  pruneExpired(current_turn: number): void {
    this.reflectionQueue = this.reflectionQueue.filter(
      (inj) => inj.created_at_turn + inj.expiry_turns > current_turn,
    )

    for (const [npc_id, queue] of this.npcQueue) {
      const filtered = queue.filter(
        (inj) => inj.created_at_turn + inj.expiry_turns > current_turn,
      )
      if (filtered.length === 0) {
        this.npcQueue.delete(npc_id)
      } else {
        this.npcQueue.set(npc_id, filtered)
      }
    }
  }

  private sortReflectionQueue(): void {
    this.reflectionQueue.sort((a, b) => {
      // HIGH priority first
      const priorityOrder = { HIGH: 0, LOW: 1 }
      const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
      if (pDiff !== 0) return pDiff
      // FIFO within same priority
      return a.created_at_turn - b.created_at_turn
    })
  }

  private mergeNPCInjections(injections: NPCInjection[]): NPCInjection {
    // Sort by created_at_turn ascending to merge in chronological order
    const sorted = [...injections].sort((a, b) => a.created_at_turn - b.created_at_turn)

    const mergedContext = sorted.map((inj) => inj.context).join('\n---\n')
    const earliestExpiry = Math.min(...sorted.map((inj) => inj.expiry_turns))
    const earliestCreatedAt = sorted[0].created_at_turn

    return {
      id: sorted[0].id,
      npc_id: sorted[0].npc_id,
      context: mergedContext,
      condition: sorted[0].condition,
      expiry_turns: earliestExpiry,
      created_at_turn: earliestCreatedAt,
    }
  }
}
