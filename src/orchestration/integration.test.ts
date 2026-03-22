import { describe, it, expect, beforeEach } from 'vitest'
import type { ILLMProvider, LLMMessage, LLMResponse } from '../ai/runner/llm-provider.js'
import type { IStateStore, IEventStore, ILoreStore } from '../infrastructure/storage/interfaces.js'
import type { Event, EventTier1, EventTier2, EventTier3, EventTier4 } from '../domain/models/event.js'
import type { LoreEntry } from '../domain/models/lore.js'
import type { GameTimestamp } from '../domain/models/common.js'
import type { ILocationGraph } from './steps/arbitration-steps.js'
import type { ReachabilityResult } from '../domain/models/pipeline-io.js'

import { AgentRunner } from '../ai/runner/agent-runner.js'
import { MainPipeline } from './pipeline/main-pipeline.js'
import { createPipelineContext } from './pipeline/types.js'
import { SignalProcessor } from '../domain/services/signal-processor.js'

// Input steps
import {
  ValidationStep,
  InputParserStep,
  AmbiguityResolverStep,
  ActionValidationStep,
  ToneSignalStep,
} from './steps/input-steps.js'

// Reflection steps
import {
  ActiveTraitStep,
  InjectionReadStep,
  ShouldSpeakStep,
  VoiceGenerationStep,
  DebateStep,
  InsistenceStep,
  WeightUpdateStep,
} from './steps/reflection-steps.js'

// Arbitration steps
import {
  ParallelQueryStep,
  Layer1InfoCheckStep,
  Layer2PhysicalCheckStep,
  Layer3SocialCheckStep,
  Layer4NarrativeCheckStep,
  Layer5DriftCheckStep,
  ArbitrationResultStep,
} from './steps/arbitration-steps.js'

// Event steps
import {
  EventContextStep,
  EventGeneratorStep,
  EventSchemaValidationStep,
  EventIdStep,
  EventWriteStep,
  SignalBStep,
  EventBroadcastStep,
} from './steps/event-steps.js'

// ============================================================
// In-Memory Store Implementations
// ============================================================

class InMemoryStateStore implements IStateStore {
  private data = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | null> {
    const val = this.data.get(key)
    return val !== undefined ? (val as T) : null
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  async listByPrefix(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix))
  }
}

class InMemoryEventStore implements IEventStore {
  readonly events: Event[] = []

  async append(event: Event): Promise<void> {
    this.events.push(event)
  }

  async getTier1(event_id: string): Promise<EventTier1 | null> {
    const e = this.events.find((ev) => ev.id === event_id)
    if (!e) return null
    return {
      id: e.id,
      title: e.title,
      timestamp: e.timestamp,
      location_id: e.location_id,
      participant_ids: e.participant_ids,
      tags: e.tags,
      weight: e.weight,
      force_level: e.force_level,
      created_at: e.created_at,
    }
  }

  async getTier2(event_id: string): Promise<EventTier2 | null> {
    const e = this.events.find((ev) => ev.id === event_id)
    if (!e) return null
    return { summary: e.summary, choice_signals: e.choice_signals }
  }

  async getTier3(event_id: string): Promise<EventTier3 | null> {
    const e = this.events.find((ev) => ev.id === event_id)
    if (!e) return null
    return {
      context: e.context,
      related_event_ids: e.related_event_ids,
      state_snapshot: e.state_snapshot,
    }
  }

  async getTier4(event_id: string): Promise<EventTier4 | null> {
    const e = this.events.find((ev) => ev.id === event_id)
    if (!e) return null
    return { narrative_text: e.narrative_text }
  }

  async getTiers(event_id: string, _tiers: number[]): Promise<Partial<Event> | null> {
    return this.events.find((ev) => ev.id === event_id) ?? null
  }

  async scanByTimeRange(_from: GameTimestamp, _to: GameTimestamp): Promise<EventTier1[]> {
    return []
  }

  async scanByParticipant(_npc_id: string, _limit: number): Promise<EventTier1[]> {
    return []
  }

  async getAllTier1(): Promise<EventTier1[]> {
    return this.events.map((e) => ({
      id: e.id,
      title: e.title,
      timestamp: e.timestamp,
      location_id: e.location_id,
      participant_ids: e.participant_ids,
      tags: e.tags,
      weight: e.weight,
      force_level: e.force_level,
      created_at: e.created_at,
    }))
  }
}

class InMemoryLoreStore implements ILoreStore {
  private entries: LoreEntry[] = []

  async append(entry: LoreEntry): Promise<void> {
    this.entries.push(entry)
  }

  async findBySubject(subject_id: string): Promise<LoreEntry[]> {
    return this.entries.filter((e) => e.subject_ids.includes(subject_id))
  }

  async findByContentHash(hash: string): Promise<LoreEntry | null> {
    return this.entries.find((e) => e.content_hash === hash) ?? null
  }

  async findByFactType(fact_type: string): Promise<LoreEntry[]> {
    return this.entries.filter((e) => e.fact_type === fact_type)
  }

  async getById(id: string): Promise<LoreEntry | null> {
    return this.entries.find((e) => e.id === id) ?? null
  }

  async update(id: string, updates: Partial<LoreEntry>): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id)
    if (idx !== -1) {
      this.entries[idx] = { ...this.entries[idx], ...updates }
    }
  }
}

// ============================================================
// MockLLMProvider
// ============================================================

interface CallRecord {
  agent_type: string
  system_content: string
  user_content: string
}

class MockLLMProvider implements ILLMProvider {
  readonly calls: CallRecord[] = []
  private handlers: Array<{
    matcher: (system: string, user: string) => boolean
    response: string
  }> = []

  /**
   * Register a handler: if the matcher returns true for the system+user messages,
   * return the given JSON string as the LLM response content.
   */
  onMatch(
    matcher: (system: string, user: string) => boolean,
    response: string,
  ): void {
    this.handlers.push({ matcher, response })
  }

  async call(messages: LLMMessage[]): Promise<LLMResponse> {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''

    // Extract agent_type from metadata if present in the call chain
    // We detect it from system prompt patterns
    let agent_type = 'unknown'
    if (system.includes('InputParser')) agent_type = 'InputParser'
    else if (system.includes('AmbiguityResolver')) agent_type = 'AmbiguityResolver'
    else if (system.includes('TraitVoiceGenerator')) agent_type = 'TraitVoiceGenerator'
    else if (system.includes('DebateGenerator')) agent_type = 'DebateGenerator'
    else if (system.includes('Layer 1')) agent_type = 'NarrativeFeasibilityJudge_L1'
    else if (system.includes('Layer 2')) agent_type = 'NarrativeFeasibilityJudge_L2'
    else if (system.includes('Layer 3')) agent_type = 'NarrativeFeasibilityJudge_L3'
    else if (system.includes('Layer 4')) agent_type = 'NarrativeFeasibilityJudge_L4'
    else if (system.includes('Layer 5')) agent_type = 'NarrativeFeasibilityJudge_L5'
    else if (system.includes('RejectionNarrativeGenerator')) agent_type = 'RejectionNarrativeGenerator'
    else if (system.includes('EventGenerator')) agent_type = 'EventGenerator'
    else if (system.includes('SignalBTagger')) agent_type = 'SignalBTagger'

    this.calls.push({ agent_type, system_content: system, user_content: user })

    for (const { matcher, response } of this.handlers) {
      if (matcher(system, user)) {
        return { content: response }
      }
    }

    throw new Error(
      `MockLLMProvider: no handler matched for agent_type="${agent_type}".\n` +
        `System: ${system.slice(0, 120)}...\nUser: ${user.slice(0, 120)}...`,
    )
  }

  getCallCount(): number {
    return this.calls.length
  }

  getCallsByAgent(agent_type: string): CallRecord[] {
    return this.calls.filter((c) => c.agent_type === agent_type)
  }

  reset(): void {
    this.calls.length = 0
  }
}

// ============================================================
// Test helpers
// ============================================================

/**
 * Builds the full Phase 2 pipeline matching the MainPipeline step chain.
 */
function buildPipeline(deps: {
  agentRunner: AgentRunner
  signalProcessor: SignalProcessor
  stateStore: IStateStore
  eventStore: IEventStore
  loreStore: ILoreStore
  locationGraph: ILocationGraph
}): MainPipeline {
  const { agentRunner, signalProcessor, stateStore, eventStore, loreStore, locationGraph } = deps

  const pipeline = new MainPipeline()

  // ── Input Pipeline ──
  pipeline.addStep(new ValidationStep())
  pipeline.addStep(new InputParserStep(agentRunner))
  pipeline.addStep(new AmbiguityResolverStep(agentRunner))
  pipeline.addStep(new ActionValidationStep())
  pipeline.addStep(new ToneSignalStep())

  // ── Reflection Pipeline ──
  // ReflectionPipeline receives ParsedIntent (from ToneSignalStep's context)
  pipeline.addStep(
    new ActiveTraitStep(signalProcessor),
    (prevOutput, context) => context.data.get('parsed_intent') as any,
  )
  pipeline.addStep(new InjectionReadStep())
  pipeline.addStep(new ShouldSpeakStep())
  pipeline.addStep(new VoiceGenerationStep(agentRunner))
  pipeline.addStep(new DebateStep(agentRunner))
  pipeline.addStep(new InsistenceStep())
  pipeline.addStep(new WeightUpdateStep(signalProcessor))

  // ── Arbitration Pipeline (per first atomic action) ──
  // Feed the first atomic_action from the parsed intent into arbitration
  pipeline.addStep(
    new ParallelQueryStep(stateStore),
    (_prevOutput, context) => {
      const parsedIntent = context.data.get('parsed_intent') as { atomic_actions: any[] }
      return parsedIntent.atomic_actions[0]
    },
  )
  pipeline.addStep(new Layer1InfoCheckStep(agentRunner))
  pipeline.addStep(new Layer2PhysicalCheckStep(locationGraph, stateStore, agentRunner))
  pipeline.addStep(new Layer3SocialCheckStep(agentRunner))
  pipeline.addStep(new Layer4NarrativeCheckStep(agentRunner, loreStore, eventStore))
  pipeline.addStep(new Layer5DriftCheckStep(agentRunner))
  pipeline.addStep(new ArbitrationResultStep())

  // ── Event Pipeline ──
  pipeline.addStep(new EventContextStep(stateStore))
  pipeline.addStep(new EventGeneratorStep(agentRunner))
  pipeline.addStep(new EventSchemaValidationStep())
  pipeline.addStep(new EventIdStep())
  pipeline.addStep(new EventWriteStep(eventStore))
  pipeline.addStep(new SignalBStep(agentRunner, signalProcessor))
  pipeline.addStep(new EventBroadcastStep())

  return pipeline
}

// ============================================================
// Integration Tests
// ============================================================

describe('Phase 2 Pipeline Integration', () => {
  let mockLLM: MockLLMProvider
  let agentRunner: AgentRunner
  let stateStore: InMemoryStateStore
  let eventStore: InMemoryEventStore
  let loreStore: InMemoryLoreStore
  let signalProcessor: SignalProcessor
  let locationGraph: ILocationGraph

  beforeEach(async () => {
    mockLLM = new MockLLMProvider()
    agentRunner = new AgentRunner(mockLLM, {
      timeout_ms: 5000,
      max_retries: 1,
      base_delay_ms: 0,
    })

    stateStore = new InMemoryStateStore()
    eventStore = new InMemoryEventStore()
    loreStore = new InMemoryLoreStore()

    // Set up signal processor with no active traits (all weights at 0 / SILENT)
    signalProcessor = new SignalProcessor(stateStore, [])

    // Build location graph via ILocationGraph interface:
    // market <-> police_station (OPEN)
    // police_station <-> mayor_office (REQUIRES_KEY, condition_detail: "mayor_key")
    //
    // We implement ILocationGraph directly since the arbitration step
    // uses the 2-arg interface, not the real LocationGraph's 3-arg version.
    locationGraph = {
      isReachable(from: string, to: string): ReachabilityResult {
        // Direct adjacency check for our simple 3-node graph
        const openEdges = new Set(['market->police_station', 'police_station->market'])
        const keyEdges = new Set([
          'police_station->mayor_office',
          'mayor_office->police_station',
        ])

        const edge = `${from}->${to}`

        if (from === to) return { reachable: true, total_travel_turns: 0 }
        if (openEdges.has(edge)) return { reachable: true, total_travel_turns: 1 }
        if (keyEdges.has(edge)) {
          // Player does not have the key
          return { reachable: false, reason: 'Requires key "mayor_key" to traverse.' }
        }
        // market -> mayor_office requires going through police_station then locked door
        if (from === 'market' && to === 'mayor_office') {
          return { reachable: false, reason: 'Path blocked: police_station->mayor_office requires key "mayor_key".' }
        }
        if (from === 'mayor_office' && to === 'market') {
          return { reachable: false, reason: 'Path blocked: mayor_office->police_station requires key "mayor_key".' }
        }

        return { reachable: false, reason: `No path from "${from}" to "${to}".` }
      },
    }

    // Set up world state in store
    await stateStore.set('character:location:player_1', 'market')
    await stateStore.set('npc:present:chief', true)
    // World summaries for EventContextStep
    await stateStore.set('world:summary:player_1', 'A small town with a market, police station, and mayor office.')
    await stateStore.set('participants:states:player_1', [
      { npc_id: 'chief', state_summary: 'On duty at the police station.' },
    ])
  })

  // ============================================================
  // Scenario A: Normal flow — move to police_station and examine
  // ============================================================

  it('Scenario A: normal flow produces narrative and writes event', async () => {
    // InputParser response
    mockLLM.onMatch(
      (sys) => sys.includes('InputParser'),
      JSON.stringify({
        intent: '前往警察局观察',
        atomic_actions: [
          { type: 'MOVE_TO', target: 'police_station', method: null, order: 0 },
          { type: 'EXAMINE', target: null, method: null, order: 1 },
        ],
        tone_signals: {},
        ambiguity_flags: [],
      }),
    )

    // Layer 1: info check passes
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 1'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // Layer 3: social check passes
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 3'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // Layer 4: narrative check passes
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 4'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // Layer 5: drift check — no drift
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 5'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // EventGenerator: produce narrative
    mockLLM.onMatch(
      (sys) => sys.includes('EventGenerator'),
      JSON.stringify({
        title: '前往警察局',
        tags: ['LOCATION_CHANGE', 'DISCOVERY'],
        weight: 'MINOR',
        summary: '玩家走到了警察局，观察周围的环境。',
        context: '玩家从市场出发前往警察局。',
        narrative_text: '你走进了警察局，空气中弥漫着陈旧文件的气味。值班台后面坐着一位神情严肃的警长。',
        state_changes: [
          { target: 'player_1', field: 'location', change_description: 'Moved to police_station' },
        ],
      }),
    )

    // SignalBTagger (triggered by LOCATION_CHANGE tag)
    mockLLM.onMatch(
      (sys) => sys.includes('SignalBTagger'),
      JSON.stringify({ choice_signals: {} }),
    )

    const pipeline = buildPipeline({
      agentRunner,
      signalProcessor,
      stateStore,
      eventStore,
      loreStore,
      locationGraph,
    })

    const context = createPipelineContext('session_001', 'player_1', 1)
    context.data.set('original_text', '走到警察局看看有什么人')

    const result = await pipeline.execute('走到警察局看看有什么人', context)

    // Verify narrative output
    expect(result.text).toContain('你走进了警察局')
    expect(result.source).toBe('event')

    // Verify event was written to EventStore
    expect(eventStore.events).toHaveLength(1)
    const writtenEvent = eventStore.events[0]
    expect(writtenEvent.title).toBe('前往警察局')
    expect(writtenEvent.narrative_text).toContain('你走进了警察局')
    expect(writtenEvent.weight).toBe('MINOR')

    // Verify the LLM calls made: InputParser, L1, L3, L4, L5, EventGenerator, SignalBTagger
    // (No AmbiguityResolver since ambiguity_flags is empty)
    // (No TraitVoiceGenerator / DebateGenerator since reflection is silent)
    const agentTypes = mockLLM.calls.map((c) => c.agent_type)
    expect(agentTypes).toContain('InputParser')
    expect(agentTypes).toContain('NarrativeFeasibilityJudge_L1')
    expect(agentTypes).toContain('NarrativeFeasibilityJudge_L3')
    expect(agentTypes).toContain('NarrativeFeasibilityJudge_L4')
    expect(agentTypes).toContain('NarrativeFeasibilityJudge_L5')
    expect(agentTypes).toContain('EventGenerator')
    expect(agentTypes).not.toContain('TraitVoiceGenerator')
    expect(agentTypes).not.toContain('DebateGenerator')
    expect(agentTypes).not.toContain('AmbiguityResolver')
  })

  // ============================================================
  // Scenario B: Arbitration rejection — locked mayor_office
  // ============================================================

  it('Scenario B: arbitration rejection short-circuits pipeline, no event created', async () => {
    // InputParser: player wants to go to mayor_office
    mockLLM.onMatch(
      (sys) => sys.includes('InputParser'),
      JSON.stringify({
        intent: '前往市长办公室',
        atomic_actions: [
          { type: 'MOVE_TO', target: 'mayor_office', method: null, order: 0 },
        ],
        tone_signals: {},
        ambiguity_flags: [],
      }),
    )

    // Layer 1: info check passes (the player knows about mayor_office)
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 1'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // RejectionNarrativeGenerator: called when Layer 2 physical check fails
    mockLLM.onMatch(
      (sys) => sys.includes('RejectionNarrativeGenerator'),
      JSON.stringify({
        narrative_text: '市长办公室的门紧锁着，你没有钥匙无法进入。',
      }),
    )

    const pipeline = buildPipeline({
      agentRunner,
      signalProcessor,
      stateStore,
      eventStore,
      loreStore,
      locationGraph,
    })

    const context = createPipelineContext('session_001', 'player_1', 1)
    context.data.set('original_text', '去市长办公室')

    const result = await pipeline.execute('去市长办公室', context)

    // Verify rejection narrative
    expect(result.text).toContain('市长办公室的门紧锁着')
    expect(result.source).toBe('rejection')

    // Verify no event was created
    expect(eventStore.events).toHaveLength(0)

    // Verify pipeline short-circuited at Layer 2
    // Layer 2 is pure code (locationGraph check), so no L2 LLM call.
    // After Layer 2 fails, RejectionNarrativeGenerator is called.
    // No Layer 3, 4, 5, EventGenerator calls should have been made.
    const agentTypes = mockLLM.calls.map((c) => c.agent_type)
    expect(agentTypes).toContain('InputParser')
    expect(agentTypes).toContain('NarrativeFeasibilityJudge_L1')
    expect(agentTypes).toContain('RejectionNarrativeGenerator')
    expect(agentTypes).not.toContain('NarrativeFeasibilityJudge_L3')
    expect(agentTypes).not.toContain('NarrativeFeasibilityJudge_L4')
    expect(agentTypes).not.toContain('NarrativeFeasibilityJudge_L5')
    expect(agentTypes).not.toContain('EventGenerator')

    // Verify the context records the failed layer
    expect(context.data.get('arbitration_failed_layer')).toBe(2)
  })

  // ============================================================
  // Scenario C: Reflection system silence — no active traits
  // ============================================================

  it('Scenario C: reflection passes silently with no active traits, no voice LLM call', async () => {
    // InputParser: simple examine action
    mockLLM.onMatch(
      (sys) => sys.includes('InputParser'),
      JSON.stringify({
        intent: '观察周围环境',
        atomic_actions: [
          { type: 'EXAMINE', target: null, method: null, order: 0 },
        ],
        tone_signals: {},
        ambiguity_flags: [],
      }),
    )

    // Layer 1 passes
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 1'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // Layer 3 passes
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 3'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // Layer 4 passes
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 4'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // Layer 5: no drift
    mockLLM.onMatch(
      (sys) => sys.includes('Layer 5'),
      JSON.stringify({ passed: true, failure_reason: null, rejection_strategy: null }),
    )

    // EventGenerator
    mockLLM.onMatch(
      (sys) => sys.includes('EventGenerator'),
      JSON.stringify({
        title: '观察市场',
        tags: ['DISCOVERY'],
        weight: 'PRIVATE',
        summary: '玩家在市场观察周围。',
        context: '一个普通的观察行为。',
        narrative_text: '你环顾四周，市场上的小贩们正在忙碌地招呼着客人。',
        state_changes: [],
      }),
    )

    const pipeline = buildPipeline({
      agentRunner,
      signalProcessor,
      stateStore,
      eventStore,
      loreStore,
      locationGraph,
    })

    const context = createPipelineContext('session_001', 'player_1', 2)
    context.data.set('original_text', '看看周围')

    const result = await pipeline.execute('看看周围', context)

    // Verify the pipeline completed and produced narrative
    expect(result.text).toContain('你环顾四周')
    expect(result.source).toBe('event')

    // Verify event was written
    expect(eventStore.events).toHaveLength(1)

    // Verify NO TraitVoiceGenerator or DebateGenerator calls were made
    // (reflection system is silent due to no active traits)
    const agentTypes = mockLLM.calls.map((c) => c.agent_type)
    expect(agentTypes).not.toContain('TraitVoiceGenerator')
    expect(agentTypes).not.toContain('DebateGenerator')

    // Verify reflection_silent flag was set
    expect(context.data.get('reflection_silent')).toBe(true)
    expect(context.data.get('skip_reflection_llm')).toBe(true)

    // Verify trait_voices was set to the empty default
    const traitVoices = context.data.get('trait_voices') as { voices: unknown[]; debate_needed: boolean }
    expect(traitVoices.voices).toHaveLength(0)
    expect(traitVoices.debate_needed).toBe(false)

    // SignalBTagger should NOT be called since tags don't include trigger tags
    // (DISCOVERY is not in SIGNAL_B_TRIGGER_TAGS)
    expect(agentTypes).not.toContain('SignalBTagger')
  })
})
