import { describe, it, expect, beforeEach } from 'vitest'
import type { ILLMProvider, LLMMessage, LLMResponse } from '../ai/runner/llm-provider.js'
import type { IStateStore, IEventStore, ILoreStore } from '../infrastructure/storage/interfaces.js'
import type { Event, EventTier1, EventTier2, EventTier3, EventTier4 } from '../domain/models/event.js'
import type { LoreEntry } from '../domain/models/lore.js'
import type { GameTimestamp } from '../domain/models/common.js'

import { AgentRunner } from '../ai/runner/agent-runner.js'
import { MainPipeline } from './pipeline/main-pipeline.js'
import { createPipelineContext } from './pipeline/types.js'
import { SignalProcessor } from '../domain/services/signal-processor.js'

// Input steps
import {
  ValidationStep,
  InputParserStep,
  ToneSignalStep,
} from './steps/input-steps.js'

// Reflection steps
import {
  ActiveTraitStep,
  InjectionReadStep,
  ShouldSpeakStep,
  VoiceDebateStep,
  InsistenceStep,
  VoiceWriteStep,
} from './steps/reflection-steps.js'

// Arbitration steps
import {
  FullContextStep,
  ActionArbiterStep,
  ArbitrationResultStep,
} from './steps/arbitration-steps.js'

// Event steps
import {
  PacingStep,
  EventGeneratorStep,
  EventSchemaValidationStep,
  EventIdStep,
  EventWriteStep,
  StateWritebackStep,
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

  onMatch(
    matcher: (system: string, user: string) => boolean,
    response: string,
  ): void {
    this.handlers.push({ matcher, response })
  }

  async call(messages: LLMMessage[]): Promise<LLMResponse> {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''

    let agent_type = 'unknown'
    if (system.includes('InputParser')) agent_type = 'InputParser'
    else if (system.includes('ActionArbiter')) agent_type = 'ActionArbiter'
    else if (system.includes('VoiceDebateGenerator')) agent_type = 'VoiceDebateGenerator'
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

function buildPipeline(deps: {
  agentRunner: AgentRunner
  signalProcessor: SignalProcessor
  stateStore: IStateStore
  eventStore: IEventStore
  loreStore: ILoreStore
}): MainPipeline {
  const { agentRunner, signalProcessor, stateStore, eventStore, loreStore } = deps

  const pipeline = new MainPipeline()

  // ── Input Pipeline ──
  pipeline.addStep(new ValidationStep())
  pipeline.addStep(new InputParserStep(agentRunner))
  pipeline.addStep(new ToneSignalStep())

  // ── Reflection Pipeline ──
  pipeline.addStep(
    new ActiveTraitStep(),
    (prevOutput, context) => context.data.get('parsed_intent') as any,
  )
  pipeline.addStep(new InjectionReadStep())
  pipeline.addStep(new ShouldSpeakStep())
  pipeline.addStep(new VoiceDebateStep(agentRunner))
  pipeline.addStep(new InsistenceStep())
  pipeline.addStep(new VoiceWriteStep())

  // ── Arbitration Pipeline (single LLM call for feasibility + check) ──
  pipeline.addStep(
    new FullContextStep(stateStore, loreStore, eventStore),
    (_prevOutput, context) => {
      const parsedIntent = context.data.get('parsed_intent') as { action: any }
      return parsedIntent.action
    },
  )
  pipeline.addStep(new ActionArbiterStep(agentRunner))
  pipeline.addStep(new ArbitrationResultStep())

  // ── Event Pipeline ──
  pipeline.addStep(new PacingStep())
  pipeline.addStep(new EventGeneratorStep(agentRunner))
  pipeline.addStep(new EventSchemaValidationStep())
  pipeline.addStep(new EventIdStep())
  pipeline.addStep(new EventWriteStep(eventStore))
  pipeline.addStep(new StateWritebackStep(stateStore, eventStore))
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

    signalProcessor = new SignalProcessor(stateStore, [])

    await stateStore.set('character:location:player_1', 'market')
    await stateStore.set('npc:present:chief', true)
    await stateStore.set('world:summary:player_1', 'A small town with a market, police station, and mayor office.')
    await stateStore.set('participants:states:player_1', [
      { npc_id: 'chief', state_summary: 'On duty at the police station.' },
    ])
  })

  // ============================================================
  // Scenario A: Normal flow — feasibility passes
  // ============================================================

  it('Scenario A: normal flow produces narrative and writes event', async () => {
    mockLLM.onMatch(
      (sys) => sys.includes('InputParser'),
      JSON.stringify({
        intent: '前往警察局观察',
        action: {
          type: 'MOVE_TO',
          target: 'police_station',
          method: '前往警察局并观察周围环境',
        },
        tone_signals: {},
        ambiguity_flags: [],
        world_assertions: [],
      }),
    )

    // ActionArbiter: feasibility passes, no check needed
    mockLLM.onMatch(
      (sys) => sys.includes('ActionArbiter'),
      JSON.stringify({
        passed: true,
        checks: [
          { dimension: 'information_completeness', passed: true, reason: null },
          { dimension: 'physical_spatial', passed: true, reason: null },
          { dimension: 'logical_consistency', passed: true, reason: null },
        ],
        drift_flag: false,
        rejection_narrative: null,
        needs_check: false,
        attribute: null,
        difficulty: null,
        modifiers: null,
        check_reason: null,
      }),
    )

    // EventGenerator
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
        choices: [
          { text: '走上前和警长搭话' },
          { text: '在警察局里四处查看' },
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
    })

    const context = createPipelineContext('session_001', 'player_1', 1)
    context.data.set('original_text', '走到警察局看看有什么人')

    const result = await pipeline.execute('走到警察局看看有什么人', context)

    expect(result.text).toContain('你走进了警察局')
    expect(result.source).toBe('event')

    expect(eventStore.events).toHaveLength(1)
    const writtenEvent = eventStore.events[0]
    expect(writtenEvent.title).toBe('前往警察局')
    expect(writtenEvent.narrative_text).toContain('你走进了警察局')
    expect(writtenEvent.weight).toBe('MINOR')

    const agentTypes = mockLLM.calls.map((c) => c.agent_type)
    expect(agentTypes).toContain('InputParser')
    expect(agentTypes).toContain('ActionArbiter')
    expect(agentTypes).toContain('EventGenerator')
    expect(agentTypes).not.toContain('VoiceDebateGenerator')
  })

  // ============================================================
  // Scenario B: Arbitration rejection — feasibility fails
  // ============================================================

  it('Scenario B: arbitration rejection short-circuits pipeline, no event created', async () => {
    mockLLM.onMatch(
      (sys) => sys.includes('InputParser'),
      JSON.stringify({
        intent: '前往市长办公室',
        action: { type: 'MOVE_TO', target: 'mayor_office', method: null },
        tone_signals: {},
        ambiguity_flags: [],
        world_assertions: [],
      }),
    )

    // ActionArbiter: feasibility fails
    mockLLM.onMatch(
      (sys) => sys.includes('ActionArbiter'),
      JSON.stringify({
        passed: false,
        checks: [
          { dimension: 'information_completeness', passed: true, reason: null },
          { dimension: 'physical_spatial', passed: false, reason: '市长办公室的门上着锁，需要钥匙才能进入。' },
          { dimension: 'logical_consistency', passed: true, reason: null },
        ],
        drift_flag: false,
        rejection_narrative: '市长办公室的门紧锁着，你没有钥匙无法进入。',
        needs_check: false,
        attribute: null,
        difficulty: null,
        modifiers: null,
        check_reason: null,
      }),
    )

    const pipeline = buildPipeline({
      agentRunner,
      signalProcessor,
      stateStore,
      eventStore,
      loreStore,
    })

    const context = createPipelineContext('session_001', 'player_1', 1)
    context.data.set('original_text', '去市长办公室')

    const result = await pipeline.execute('去市长办公室', context)

    expect(result.text).toContain('市长办公室的门紧锁着')
    expect(result.source).toBe('rejection')

    expect(eventStore.events).toHaveLength(0)

    const agentTypes = mockLLM.calls.map((c) => c.agent_type)
    expect(agentTypes).toContain('InputParser')
    expect(agentTypes).toContain('ActionArbiter')
    expect(agentTypes).not.toContain('EventGenerator')
  })

  // ============================================================
  // Scenario C: Reflection system silence — no active traits
  // ============================================================

  it('Scenario C: reflection passes silently with no active traits, no voice LLM call', async () => {
    mockLLM.onMatch(
      (sys) => sys.includes('InputParser'),
      JSON.stringify({
        intent: '观察周围环境',
        action: { type: 'EXAMINE', target: null, method: null },
        tone_signals: {},
        ambiguity_flags: [],
        world_assertions: [],
      }),
    )

    // ActionArbiter: passes, no check
    mockLLM.onMatch(
      (sys) => sys.includes('ActionArbiter'),
      JSON.stringify({
        passed: true,
        checks: [
          { dimension: 'information_completeness', passed: true, reason: null },
          { dimension: 'physical_spatial', passed: true, reason: null },
          { dimension: 'logical_consistency', passed: true, reason: null },
        ],
        drift_flag: false,
        rejection_narrative: null,
        needs_check: false,
        attribute: null,
        difficulty: null,
        modifiers: null,
        check_reason: null,
      }),
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
        choices: [
          { text: '走到最近的小贩摊前交谈' },
          { text: '离开市场继续往前走' },
        ],
      }),
    )

    const pipeline = buildPipeline({
      agentRunner,
      signalProcessor,
      stateStore,
      eventStore,
      loreStore,
    })

    const context = createPipelineContext('session_001', 'player_1', 2)
    context.data.set('original_text', '看看周围')

    const result = await pipeline.execute('看看周围', context)

    expect(result.text).toContain('你环顾四周')
    expect(result.source).toBe('event')

    expect(eventStore.events).toHaveLength(1)

    const agentTypes = mockLLM.calls.map((c) => c.agent_type)
    expect(agentTypes).not.toContain('VoiceDebateGenerator')

    expect(context.data.get('reflection_silent')).toBe(true)
    expect(context.data.get('skip_reflection_llm')).toBe(true)

    const traitVoices = context.data.get('trait_voices') as { voices: unknown[]; debate_needed: boolean }
    expect(traitVoices.voices).toHaveLength(0)
    expect(traitVoices.debate_needed).toBe(false)

    expect(agentTypes).not.toContain('SignalBTagger')
  })
})
