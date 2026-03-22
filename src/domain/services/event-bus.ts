import type { EventTier1 } from '../../domain/models/event.js'
import type { CharacterDynamicState, RelationshipEntry } from '../../domain/models/character.js'
import type { IStateStore } from '../../infrastructure/storage/interfaces.js'

// ============================================================
// EventSubscriber
// ============================================================

export interface EventSubscriber {
  id: string
  handle(event: EventTier1): Promise<void>
}

// ============================================================
// DeadLetterQueue
// ============================================================

export interface DeadLetterEntry {
  event_id: string
  subscriber_id: string
  error: string
  timestamp: number
  retry_count: number
}

export class DeadLetterQueue {
  private entries: DeadLetterEntry[] = []

  add(entry: DeadLetterEntry): void {
    this.entries.push(entry)
  }

  getForSubscriber(subscriber_id: string): DeadLetterEntry[] {
    return this.entries.filter((e) => e.subscriber_id === subscriber_id)
  }

  remove(event_id: string, subscriber_id: string): void {
    this.entries = this.entries.filter(
      (e) => !(e.event_id === event_id && e.subscriber_id === subscriber_id),
    )
  }

  getAll(): DeadLetterEntry[] {
    return [...this.entries]
  }
}

// ============================================================
// BroadcastRouter
// ============================================================

export interface RoutingResult {
  direct_participants: string[]
  tier_a_recipients: string[]
  tier_b_recipients: string[]
}

export class BroadcastRouter {
  constructor(private stateStore: IStateStore) {}

  async routeEvent(event: EventTier1, allNpcIds: string[]): Promise<RoutingResult> {
    const participantSet = new Set(event.participant_ids)

    // Direct participants: participant_ids that are NPCs
    const direct_participants = allNpcIds.filter((id) => participantSet.has(id))

    // If PRIVATE weight, only direct participants get notified
    if (event.weight === 'PRIVATE') {
      return {
        direct_participants,
        tier_a_recipients: [],
        tier_b_recipients: [],
      }
    }

    const directSet = new Set(direct_participants)
    const tier_a_recipients: string[] = []
    const tier_b_recipients: string[] = []

    // Classify non-participant NPCs by tier
    for (const npcId of allNpcIds) {
      if (directSet.has(npcId)) continue

      const state = await this.stateStore.get<CharacterDynamicState>(
        `character:${npcId}:state`,
      )
      if (!state) continue

      if (state.tier === 'A') {
        const include = await this.shouldIncludeTierA(event, npcId, state)
        if (include) {
          tier_a_recipients.push(npcId)
        }
      } else if (state.tier === 'B') {
        // Tier B: only include if NPC current_location_id matches event location
        if (state.current_location_id === event.location_id) {
          tier_b_recipients.push(npcId)
        }
      }
      // Tier C: never include
    }

    return { direct_participants, tier_a_recipients, tier_b_recipients }
  }

  private async shouldIncludeTierA(
    event: EventTier1,
    npcId: string,
    state: CharacterDynamicState,
  ): Promise<boolean> {
    if (event.weight === 'MAJOR') {
      return true
    }

    if (event.weight === 'SIGNIFICANT') {
      // Check same region
      const npcRegion = await this.stateStore.get<string>(
        `location:region:${state.current_location_id}`,
      )
      const eventRegion = await this.stateStore.get<string>(
        `location:region:${event.location_id}`,
      )
      if (npcRegion != null && eventRegion != null && npcRegion === eventRegion) {
        return true
      }

      // Check strong relationship with any participant
      for (const participantId of event.participant_ids) {
        const rel = await this.stateStore.get<RelationshipEntry>(
          `relationship:${participantId}:${npcId}`,
        )
        if (rel && rel.strength > 0.6) {
          return true
        }
      }
    }

    // MINOR → exclude
    return false
  }
}

// ============================================================
// EventBus
// ============================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class EventBus {
  private subscribers: Map<string, EventSubscriber> = new Map()
  private staticSubscriberIds: Set<string> = new Set()

  constructor(private deadLetterQueue: DeadLetterQueue) {}

  registerStatic(subscriber: EventSubscriber): void {
    this.subscribers.set(subscriber.id, subscriber)
    this.staticSubscriberIds.add(subscriber.id)
  }

  registerDynamic(subscriber: EventSubscriber): void {
    this.subscribers.set(subscriber.id, subscriber)
  }

  unregister(id: string): void {
    this.subscribers.delete(id)
    this.staticSubscriberIds.delete(id)
  }

  async publish(event: EventTier1): Promise<void> {
    const subscriberIds = Array.from(this.subscribers.keys())
    await this.dispatchToSubscribers(event, subscriberIds)
  }

  async publishToSubscribers(event: EventTier1, subscriberIds: string[]): Promise<void> {
    // Include all static subscribers plus the specified ones
    const targetIds = new Set(subscriberIds)
    for (const staticId of this.staticSubscriberIds) {
      targetIds.add(staticId)
    }
    await this.dispatchToSubscribers(event, Array.from(targetIds))
  }

  private async dispatchToSubscribers(
    event: EventTier1,
    subscriberIds: string[],
  ): Promise<void> {
    const subscribers = subscriberIds
      .map((id) => this.subscribers.get(id))
      .filter((s): s is EventSubscriber => s != null)

    const results = await Promise.allSettled(
      subscribers.map((s) => s.handle(event)),
    )

    // Collect failures for retry
    const failed: EventSubscriber[] = []
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        failed.push(subscribers[i])
      }
    }

    // Retry failed subscribers up to 3 times with exponential backoff
    const retryDelays = [100, 200, 400]
    let toRetry = failed

    for (let attempt = 0; attempt < retryDelays.length && toRetry.length > 0; attempt++) {
      await delay(retryDelays[attempt])

      const retryResults = await Promise.allSettled(
        toRetry.map((s) => s.handle(event)),
      )

      const stillFailed: EventSubscriber[] = []
      for (let i = 0; i < retryResults.length; i++) {
        if (retryResults[i].status === 'rejected') {
          stillFailed.push(toRetry[i])
        }
      }
      toRetry = stillFailed
    }

    // Send remaining failures to dead letter queue
    for (const subscriber of toRetry) {
      this.deadLetterQueue.add({
        event_id: event.id,
        subscriber_id: subscriber.id,
        error: 'Failed after 3 retries',
        timestamp: Date.now(),
        retry_count: 3,
      })
    }
  }
}

// ============================================================
// AsyncCompletionGuard
// ============================================================

export class AsyncCompletionGuard {
  private pending: Set<string> = new Set()

  markPending(id: string): void {
    this.pending.add(id)
  }

  markComplete(id: string): void {
    this.pending.delete(id)
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  async waitForAll(timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (this.pending.size > 0) {
      if (Date.now() - start >= timeoutMs) {
        return false
      }
      await delay(10)
    }
    return true
  }
}
