import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  EventBus,
  BroadcastRouter,
  DeadLetterQueue,
  AsyncCompletionGuard,
} from './event-bus.js'
import type { EventSubscriber } from './event-bus.js'
import { InMemoryInjectionQueueManager } from './injection-queue-manager.js'
import { NarrativeRailAgent } from './narrative-rail-agent.js'
import { LoreCanonicalizer } from './lore-canonicalizer.js'
import { PropagationScheduler } from './propagation-scheduler.js'
import { AgentScheduler } from './agent-scheduler.js'
import { InMemoryStateStore } from '../../infrastructure/storage/state-store.js'
import { InMemoryEventStore } from '../../infrastructure/storage/event-store.js'
import { InMemoryLoreStore } from '../../infrastructure/storage/lore-store.js'
import type { EventTier1 } from '../models/event.js'
import type { ReflectionInjection, NPCInjection } from '../models/injection.js'
import type { ILLMProvider, LLMMessage, LLMResponse } from '../../ai/runner/llm-provider.js'
import { AgentRunner } from '../../ai/runner/agent-runner.js'

// ============================================================
// Mock LLM Provider
// ============================================================

class MockLLMProvider implements ILLMProvider {
  responses: string[] = []
  private callIndex = 0
  defaultResponse = '{}'

  /** Queue responses in order they'll be called */
  queueResponse(response: string): void {
    this.responses.push(response)
  }

  /** Set a single response for all calls */
  setDefault(response: string): void {
    this.defaultResponse = response
  }

  async call(_messages: LLMMessage[], _options?: { temperature?: number; max_tokens?: number }): Promise<LLMResponse> {
    const content = this.callIndex < this.responses.length
      ? this.responses[this.callIndex++]
      : this.defaultResponse
    return { content, usage: { input_tokens: 10, output_tokens: 10 } }
  }
}

// Helper to create a test EventTier1
function makeEvent(overrides: Partial<EventTier1> = {}): EventTier1 {
  return {
    id: 'evt_1',
    title: 'Test Event',
    timestamp: { day: 1, hour: 10, turn: 5 },
    location_id: 'market',
    participant_ids: ['player', 'npc_a'],
    tags: ['DIALOGUE'],
    weight: 'MINOR',
    force_level: 0,
    created_at: Date.now(),
    ...overrides,
  }
}

// ============================================================
// DeadLetterQueue
// ============================================================

describe('DeadLetterQueue', () => {
  let dlq: DeadLetterQueue

  beforeEach(() => {
    dlq = new DeadLetterQueue()
  })

  it('adds and retrieves entries', () => {
    dlq.add({ event_id: 'e1', subscriber_id: 's1', error: 'fail', timestamp: 1, retry_count: 3 })
    expect(dlq.getAll()).toHaveLength(1)
    expect(dlq.getForSubscriber('s1')).toHaveLength(1)
    expect(dlq.getForSubscriber('s2')).toHaveLength(0)
  })

  it('removes specific entry', () => {
    dlq.add({ event_id: 'e1', subscriber_id: 's1', error: 'fail', timestamp: 1, retry_count: 3 })
    dlq.add({ event_id: 'e2', subscriber_id: 's1', error: 'fail', timestamp: 2, retry_count: 3 })
    dlq.remove('e1', 's1')
    expect(dlq.getAll()).toHaveLength(1)
    expect(dlq.getAll()[0].event_id).toBe('e2')
  })
})

// ============================================================
// BroadcastRouter
// ============================================================

describe('BroadcastRouter', () => {
  let store: InMemoryStateStore
  let router: BroadcastRouter

  beforeEach(() => {
    store = new InMemoryStateStore()
    router = new BroadcastRouter(store)
  })

  it('routes PRIVATE events only to direct participants', async () => {
    await store.set('character:npc_a:state', {
      npc_id: 'npc_a', tier: 'A', current_location_id: 'market',
      current_emotion: 'neutral', interaction_count: 0, is_active: false, goal_queue: [],
    })

    const event = makeEvent({ weight: 'PRIVATE', participant_ids: ['player', 'npc_a'] })
    const result = await router.routeEvent(event, ['npc_a', 'npc_b', 'npc_c'])

    expect(result.direct_participants).toEqual(['npc_a'])
    expect(result.tier_a_recipients).toHaveLength(0)
    expect(result.tier_b_recipients).toHaveLength(0)
  })

  it('routes MAJOR events to all Tier A NPCs', async () => {
    await store.set('character:npc_a:state', {
      npc_id: 'npc_a', tier: 'A', current_location_id: 'market',
      current_emotion: 'neutral', interaction_count: 0, is_active: false, goal_queue: [],
    })
    await store.set('character:npc_b:state', {
      npc_id: 'npc_b', tier: 'A', current_location_id: 'dock',
      current_emotion: 'neutral', interaction_count: 0, is_active: false, goal_queue: [],
    })

    const event = makeEvent({ weight: 'MAJOR', participant_ids: ['player', 'npc_a'] })
    const result = await router.routeEvent(event, ['npc_a', 'npc_b'])

    expect(result.direct_participants).toEqual(['npc_a'])
    expect(result.tier_a_recipients).toEqual(['npc_b'])
  })

  it('routes Tier B only if same location', async () => {
    await store.set('character:npc_b:state', {
      npc_id: 'npc_b', tier: 'B', current_location_id: 'market',
      current_emotion: 'neutral', interaction_count: 0, is_active: false, goal_queue: [],
    })
    await store.set('character:npc_c:state', {
      npc_id: 'npc_c', tier: 'B', current_location_id: 'dock',
      current_emotion: 'neutral', interaction_count: 0, is_active: false, goal_queue: [],
    })

    const event = makeEvent({ weight: 'SIGNIFICANT', location_id: 'market' })
    const result = await router.routeEvent(event, ['npc_b', 'npc_c'])

    expect(result.tier_b_recipients).toEqual(['npc_b'])
  })
})

// ============================================================
// EventBus
// ============================================================

describe('EventBus', () => {
  let dlq: DeadLetterQueue
  let bus: EventBus

  beforeEach(() => {
    dlq = new DeadLetterQueue()
    bus = new EventBus(dlq)
  })

  it('publishes to all subscribers', async () => {
    const calls: string[] = []
    bus.registerStatic({
      id: 'sub1',
      handle: async () => { calls.push('sub1') },
    })
    bus.registerDynamic({
      id: 'sub2',
      handle: async () => { calls.push('sub2') },
    })

    await bus.publish(makeEvent())
    expect(calls).toContain('sub1')
    expect(calls).toContain('sub2')
  })

  it('publishToSubscribers includes static subscribers automatically', async () => {
    const calls: string[] = []
    bus.registerStatic({
      id: 'static1',
      handle: async () => { calls.push('static1') },
    })
    bus.registerDynamic({
      id: 'dyn1',
      handle: async () => { calls.push('dyn1') },
    })
    bus.registerDynamic({
      id: 'dyn2',
      handle: async () => { calls.push('dyn2') },
    })

    await bus.publishToSubscribers(makeEvent(), ['dyn1'])
    expect(calls).toContain('static1')
    expect(calls).toContain('dyn1')
    expect(calls).not.toContain('dyn2')
  })

  it('sends permanently failing subscribers to DLQ', async () => {
    bus.registerStatic({
      id: 'failing',
      handle: async () => { throw new Error('always fails') },
    })

    await bus.publish(makeEvent())
    expect(dlq.getAll()).toHaveLength(1)
    expect(dlq.getAll()[0].subscriber_id).toBe('failing')
  })

  it('unregister removes subscriber', async () => {
    const calls: string[] = []
    bus.registerDynamic({
      id: 'temp',
      handle: async () => { calls.push('temp') },
    })
    bus.unregister('temp')

    await bus.publish(makeEvent())
    expect(calls).toHaveLength(0)
  })
})

// ============================================================
// AsyncCompletionGuard
// ============================================================

describe('AsyncCompletionGuard', () => {
  it('tracks pending and completion', async () => {
    const guard = new AsyncCompletionGuard()
    expect(guard.hasPending()).toBe(false)

    guard.markPending('task1')
    expect(guard.hasPending()).toBe(true)

    guard.markComplete('task1')
    expect(guard.hasPending()).toBe(false)
  })

  it('waitForAll returns true when nothing pending', async () => {
    const guard = new AsyncCompletionGuard()
    const result = await guard.waitForAll(100)
    expect(result).toBe(true)
  })

  it('waitForAll times out if tasks remain', async () => {
    const guard = new AsyncCompletionGuard()
    guard.markPending('stuck')
    const result = await guard.waitForAll(50)
    expect(result).toBe(false)
  })
})

// ============================================================
// InjectionQueueManager
// ============================================================

describe('InMemoryInjectionQueueManager', () => {
  let mgr: InMemoryInjectionQueueManager

  beforeEach(() => {
    mgr = new InMemoryInjectionQueueManager()
  })

  it('enqueues and dequeues reflections by priority', () => {
    const low: ReflectionInjection = {
      id: 'r1', voice_id: 'v1', content: 'low', priority: 'LOW',
      expiry_turns: 5, created_at_turn: 1,
    }
    const high: ReflectionInjection = {
      id: 'r2', voice_id: 'v1', content: 'high', priority: 'HIGH',
      expiry_turns: 5, created_at_turn: 2,
    }

    mgr.enqueueReflection(low)
    mgr.enqueueReflection(high)

    const first = mgr.dequeueReflection()
    expect(first?.priority).toBe('HIGH')
    const second = mgr.dequeueReflection()
    expect(second?.priority).toBe('LOW')
    expect(mgr.dequeueReflection()).toBeNull()
  })

  it('merges multiple NPC injections on dequeue', () => {
    const inj1: NPCInjection = {
      id: 'n1', npc_id: 'npc_a', context: 'first topic',
      condition: 'cond1', expiry_turns: 5, created_at_turn: 1,
    }
    const inj2: NPCInjection = {
      id: 'n2', npc_id: 'npc_a', context: 'second topic',
      condition: 'cond2', expiry_turns: 3, created_at_turn: 2,
    }

    mgr.enqueueNPC(inj1)
    mgr.enqueueNPC(inj2)

    const merged = mgr.dequeueNPC('npc_a')
    expect(merged).not.toBeNull()
    expect(merged!.context).toContain('first topic')
    expect(merged!.context).toContain('second topic')
    expect(merged!.context).toContain('---')
    // Earliest expiry
    expect(merged!.expiry_turns).toBe(3)
  })

  it('pruneExpired removes expired entries', () => {
    const inj: ReflectionInjection = {
      id: 'r1', voice_id: 'v1', content: 'test', priority: 'LOW',
      expiry_turns: 3, created_at_turn: 1,
    }
    mgr.enqueueReflection(inj)
    expect(mgr.peekReflections()).toHaveLength(1)

    mgr.pruneExpired(4) // 1 + 3 = 4, so expired
    expect(mgr.peekReflections()).toHaveLength(0)
  })

  it('pruneExpired keeps non-expired entries', () => {
    const inj: ReflectionInjection = {
      id: 'r1', voice_id: 'v1', content: 'test', priority: 'LOW',
      expiry_turns: 5, created_at_turn: 1,
    }
    mgr.enqueueReflection(inj)
    mgr.pruneExpired(3) // 1 + 5 = 6 > 3, not expired
    expect(mgr.peekReflections()).toHaveLength(1)
  })

  it('dequeueNPC returns null for unknown NPC', () => {
    expect(mgr.dequeueNPC('unknown')).toBeNull()
  })
})

// ============================================================
// NarrativeRailAgent
// ============================================================

describe('NarrativeRailAgent', () => {
  let mockLLM: MockLLMProvider
  let runner: AgentRunner
  let eventStore: InMemoryEventStore
  let stateStore: InMemoryStateStore
  let agent: NarrativeRailAgent

  const testPhase = {
    phase_id: 'phase_1',
    description: 'Investigation begins',
    direction_summary: 'Player should investigate the crime scene',
  }

  beforeEach(() => {
    mockLLM = new MockLLMProvider()
    runner = new AgentRunner(mockLLM, { timeout_ms: 5000, max_retries: 1, base_delay_ms: 10 })
    eventStore = new InMemoryEventStore()
    stateStore = new InMemoryStateStore()
    agent = new NarrativeRailAgent(runner, eventStore, stateStore)
  })

  it('assessDrift returns NONE when LLM says no drift', async () => {
    mockLLM.queueResponse(JSON.stringify({
      drift_level: 'NONE',
      needs_intervention: false,
      suggested_level: 0,
      reasoning: 'Player is on track',
    }))

    const result = await agent.assessDrift(testPhase, 5)
    expect(result.drift_level).toBe('NONE')
    expect(result.needs_intervention).toBe(false)
  })

  it('assessDrift returns default on LLM failure', async () => {
    mockLLM.setDefault('invalid json {')
    const result = await agent.assessDrift(testPhase, 5)
    expect(result.drift_level).toBe('NONE')
    expect(result.needs_intervention).toBe(false)
  })

  it('generateIntervention returns null when not needed', async () => {
    const assessment = {
      drift_level: 'NONE' as const,
      needs_intervention: false,
      suggested_level: 0,
      reasoning: 'OK',
    }
    const result = await agent.generateIntervention(assessment, testPhase, 5, 'player')
    expect(result).toBeNull()
  })

  it('generates level 1 reflection injection', async () => {
    mockLLM.queueResponse(JSON.stringify({
      voice_id: 'inner_voice',
      content: 'Maybe you should check the crime scene...',
    }))

    const assessment = {
      drift_level: 'MILD' as const,
      needs_intervention: true,
      suggested_level: 1,
      reasoning: 'Slight drift',
    }
    const result = await agent.generateIntervention(assessment, testPhase, 5, 'player')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('reflection')
    if (result!.type === 'reflection') {
      expect(result!.injection.content).toContain('crime scene')
    }
  })

  it('escalates to level 2 after consecutive ineffective interventions', async () => {
    agent.recordInterventionEffect(false)
    agent.recordInterventionEffect(false)
    expect(agent.getConsecutiveIneffective()).toBe(2)

    await stateStore.set('narrative_rail:phase_npcs:phase_1', ['detective_npc'])

    mockLLM.queueResponse(JSON.stringify({
      context: 'The detective has new leads to share',
      condition: 'next_conversation',
    }))

    const assessment = {
      drift_level: 'MODERATE' as const,
      needs_intervention: true,
      suggested_level: 1,
      reasoning: 'Moderate drift',
    }
    const result = await agent.generateIntervention(assessment, testPhase, 10, 'player')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('npc')
  })

  it('recordInterventionEffect resets counter on success', () => {
    agent.recordInterventionEffect(false)
    agent.recordInterventionEffect(false)
    expect(agent.getConsecutiveIneffective()).toBe(2)

    agent.recordInterventionEffect(true)
    expect(agent.getConsecutiveIneffective()).toBe(0)
  })
})

// ============================================================
// LoreCanonicalizer
// ============================================================

describe('LoreCanonicalizer', () => {
  let mockLLM: MockLLMProvider
  let runner: AgentRunner
  let loreStore: InMemoryLoreStore
  let stateStore: InMemoryStateStore
  let canonicalizer: LoreCanonicalizer

  beforeEach(() => {
    mockLLM = new MockLLMProvider()
    runner = new AgentRunner(mockLLM, { timeout_ms: 5000, max_retries: 1, base_delay_ms: 10 })
    loreStore = new InMemoryLoreStore()
    stateStore = new InMemoryStateStore()
    canonicalizer = new LoreCanonicalizer(runner, loreStore, stateStore)
  })

  it('extracts facts from narrative text', async () => {
    mockLLM.queueResponse(JSON.stringify({
      facts: [
        {
          content: 'The detective was born in the old quarter',
          fact_type: 'NPC_PERSONAL',
          subject_ids: ['detective'],
          confidence: 0.9,
        },
      ],
    }))

    const facts = await canonicalizer.extractFacts('Some narrative text', 'evt_1')
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toContain('detective')
  })

  it('filters out low confidence facts', async () => {
    mockLLM.queueResponse(JSON.stringify({
      facts: [
        {
          content: 'Maybe they were friends',
          fact_type: 'RELATIONSHIP',
          subject_ids: ['a', 'b'],
          confidence: 0.3,
        },
      ],
    }))

    const facts = await canonicalizer.extractFacts('text', 'evt_1')
    expect(facts).toHaveLength(0)
  })

  it('canonicalize creates lore entries for new facts', async () => {
    // First call: FactExtractor, Second call: ConsistencyChecker
    mockLLM.queueResponse(JSON.stringify({
      facts: [
        {
          content: 'Detective Li grew up in Chinatown',
          fact_type: 'NPC_PERSONAL',
          subject_ids: ['detective_li'],
          confidence: 0.85,
        },
      ],
    }))
    mockLLM.queueResponse(JSON.stringify({
      verdict: 'SUPPLEMENTARY',
      reasoning: 'New information',
    }))

    const entries = await canonicalizer.canonicalize('narrative', 'evt_1', 5)
    expect(entries).toHaveLength(1)
    expect(entries[0].authority_level).toBe('AI_CANONICALIZED')
    expect(entries[0].content).toContain('Chinatown')
  })

  it('skips contradictory facts when existing is AUTHOR_PRESET', async () => {
    // Pre-seed lore
    await loreStore.append({
      id: 'lore_1',
      content: 'Detective Li grew up in Shanghai',
      fact_type: 'NPC_PERSONAL',
      authority_level: 'AUTHOR_PRESET',
      subject_ids: ['detective_li'],
      source_event_id: null,
      created_at_turn: 0,
      causal_chain: [],
      related_lore_ids: [],
      content_hash: 'preset_hash',
    })

    mockLLM.queueResponse(JSON.stringify({
      facts: [
        {
          content: 'Detective Li grew up in Beijing',
          fact_type: 'NPC_PERSONAL',
          subject_ids: ['detective_li'],
          confidence: 0.9,
        },
      ],
    }))
    mockLLM.queueResponse(JSON.stringify({
      verdict: 'CONTRADICTORY',
      reasoning: 'Birthplace conflict',
    }))

    const entries = await canonicalizer.canonicalize('narrative', 'evt_1', 5)
    expect(entries).toHaveLength(0)
  })

  it('returns empty on extraction failure', async () => {
    mockLLM.setDefault('not json')
    const facts = await canonicalizer.extractFacts('text', 'evt_1')
    expect(facts).toHaveLength(0)
  })
})

// ============================================================
// PropagationScheduler
// ============================================================

describe('PropagationScheduler', () => {
  let stateStore: InMemoryStateStore
  let injectionMgr: InMemoryInjectionQueueManager
  let scheduler: PropagationScheduler

  beforeEach(() => {
    stateStore = new InMemoryStateStore()
    injectionMgr = new InMemoryInjectionQueueManager()
    scheduler = new PropagationScheduler(stateStore, injectionMgr)
  })

  it('does nothing for MINOR events', async () => {
    const event = makeEvent({ weight: 'MINOR' })
    await scheduler.schedulePropagation(event, 'summary', [], 5)
    const schedule = await stateStore.get<unknown[]>('propagation:schedule')
    expect(schedule).toBeNull()
  })

  it('schedules propagation for SIGNIFICANT events', async () => {
    // Set up relationship chain: npc_a → npc_b → npc_c
    await stateStore.set('relationship:npc_a:npc_b', {
      from_npc_id: 'npc_a', to_npc_id: 'npc_b',
      semantic_description: 'colleagues', strength: 0.7,
      last_updated_event_id: 'evt_0',
    })
    await stateStore.set('relationship:npc_b:npc_c', {
      from_npc_id: 'npc_b', to_npc_id: 'npc_c',
      semantic_description: 'friends', strength: 0.8,
      last_updated_event_id: 'evt_0',
    })

    const event = makeEvent({
      weight: 'SIGNIFICANT',
      participant_ids: ['player', 'npc_a'],
    })
    await scheduler.schedulePropagation(event, 'Something happened', ['npc_a', 'npc_b'], 5)

    const schedule = await stateStore.get<unknown[]>('propagation:schedule')
    expect(schedule).not.toBeNull()
    expect(schedule!.length).toBeGreaterThan(0)
  })

  it('processScheduledPropagations delivers due entries', async () => {
    await stateStore.set('propagation:schedule', [
      {
        event_id: 'e1',
        target_npc_id: 'npc_x',
        deliver_at_turn: 5,
        tier2_summary: 'A fight broke out',
        source_event_title: 'Bar Fight',
      },
      {
        event_id: 'e2',
        target_npc_id: 'npc_y',
        deliver_at_turn: 10,
        tier2_summary: 'Later event',
        source_event_title: 'Later',
      },
    ])

    const count = await scheduler.processScheduledPropagations(5)
    expect(count).toBe(1)

    // npc_x should have injection
    const inj = injectionMgr.dequeueNPC('npc_x')
    expect(inj).not.toBeNull()
    expect(inj!.context).toContain('Bar Fight')

    // Remaining schedule should have 1 entry
    const remaining = await stateStore.get<unknown[]>('propagation:schedule')
    expect(remaining).toHaveLength(1)
  })
})

// ============================================================
// AgentScheduler (Phase 4 extended)
// ============================================================

describe('AgentScheduler (Phase 4)', () => {
  let stateStore: InMemoryStateStore
  let injectionMgr: InMemoryInjectionQueueManager

  beforeEach(() => {
    stateStore = new InMemoryStateStore()
    injectionMgr = new InMemoryInjectionQueueManager()
  })

  it('runs injection queue pruning during end-of-turn', async () => {
    // Add an expired injection
    injectionMgr.enqueueReflection({
      id: 'r1', voice_id: 'v1', content: 'old', priority: 'LOW',
      expiry_turns: 2, created_at_turn: 1,
    })
    expect(injectionMgr.peekReflections()).toHaveLength(1)

    const mockIntentGen = { generateIntent: vi.fn() } as any
    const mockTierMgr = { checkUpgrade: vi.fn(), checkDowngrade: vi.fn() } as any

    const scheduler = new AgentScheduler(stateStore, mockIntentGen, mockTierMgr, {
      injectionQueueManager: injectionMgr,
    })

    await scheduler.runEndOfTurn(10, null)

    // Injection should be pruned (1 + 2 = 3 <= 10)
    expect(injectionMgr.peekReflections()).toHaveLength(0)
  })
})
