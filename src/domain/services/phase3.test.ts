import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryStateStore,
  InMemoryEventStore,
  InMemoryLoreStore,
  InMemoryLongTermMemoryStore,
} from '../../infrastructure/storage/index.js'
import type { ILLMProvider, LLMMessage, LLMResponse } from '../../ai/runner/llm-provider.js'
import { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { CharacterDynamicState, MemoryBuffer, TierCTemplate } from '../models/character.js'
import type { LocationState } from '../models/world.js'
import type { GameTime } from '../models/common.js'
import type { LoreEntry } from '../models/lore.js'
import type { StateChange } from '../models/pipeline-io.js'
import { NPCResponseGenerator } from './npc-response-generator.js'
import { SubjectiveMemoryGenerator, type MemoryEventInput } from './subjective-memory-generator.js'
import { NPCIntentGenerator } from './npc-intent-generator.js'
import { NPCTierManager } from './npc-tier-manager.js'
import { ConversationManager } from './conversation-manager.js'
import { AgentScheduler } from './agent-scheduler.js'
import { WorldAgent } from './world-agent.js'

// ============================================================
// MockLLMProvider: returns JSON based on message content patterns
// ============================================================

class MockLLMProvider implements ILLMProvider {
  private responses: Array<{ pattern: RegExp; response: string }> = []
  private defaultResponse: string = '{}'
  public callCount = 0

  addResponse(pattern: RegExp, response: string): void {
    this.responses.push({ pattern, response })
  }

  setDefault(response: string): void {
    this.defaultResponse = response
  }

  async call(messages: LLMMessage[], _options?: { temperature?: number; max_tokens?: number }): Promise<LLMResponse> {
    this.callCount++
    const combined = messages.map((m) => m.content).join('\n')

    for (const { pattern, response } of this.responses) {
      if (pattern.test(combined)) {
        return { content: response }
      }
    }

    return { content: this.defaultResponse }
  }
}

// ============================================================
// Test data helpers
// ============================================================

function makeTierAState(npc_id: string, overrides?: Partial<CharacterDynamicState>): CharacterDynamicState {
  return {
    npc_id,
    tier: 'A',
    current_emotion: 'neutral',
    current_location_id: 'tavern',
    interaction_count: 5,
    is_active: false,
    goal_queue: [
      {
        id: 'goal-1',
        description: 'Find the lost artifact',
        priority: 8,
        created_from_event_id: 'evt-001',
        status: 'IN_PROGRESS',
      },
    ],
    ...overrides,
  }
}

function makeTierBState(npc_id: string, overrides?: Partial<CharacterDynamicState>): CharacterDynamicState {
  return {
    npc_id,
    tier: 'B',
    current_emotion: 'curious',
    current_location_id: 'market',
    interaction_count: 3,
    is_active: false,
    goal_queue: [],
    ...overrides,
  }
}

function makeTierCState(npc_id: string, overrides?: Partial<CharacterDynamicState>): CharacterDynamicState {
  return {
    npc_id,
    tier: 'C',
    current_emotion: 'neutral',
    current_location_id: 'gate',
    interaction_count: 0,
    is_active: false,
    goal_queue: [],
    ...overrides,
  }
}

function makeLocationState(id: string, overrides?: Partial<LocationState>): LocationState {
  return {
    id,
    name: `Location ${id}`,
    region_id: 'region-1',
    current_status: 'peaceful',
    accessibility: 'OPEN',
    current_occupant_ids: [],
    is_frozen: false,
    last_observed_turn: 0,
    causal_chain: [],
    ...overrides,
  }
}

function makeLoreEntry(npc_id: string, fact_type: 'NPC_PERSONAL' | 'RELATIONSHIP', content: string): LoreEntry {
  return {
    id: `lore-${Math.random().toString(36).slice(2, 8)}`,
    content,
    fact_type,
    authority_level: 'AUTHOR_PRESET',
    subject_ids: [npc_id],
    source_event_id: null,
    created_at_turn: 1,
    causal_chain: [],
    related_lore_ids: [],
    content_hash: `hash-${content.slice(0, 10)}`,
  }
}

const NPC_RESPONSE_JSON = JSON.stringify({
  response_text: 'Greetings, traveler. What brings you here?',
  emotion_change: 'friendly',
  relationship_change_signal: null,
})

const SUBJECTIVE_MEMORY_JSON = JSON.stringify({
  subjective_summary: 'The stranger seemed trustworthy but I remain cautious.',
  distortion_type: 'NONE',
})

const NPC_INTENT_JSON = JSON.stringify({
  intent: 'Search the old library for clues about the artifact',
  actions: [{ type: 'MOVE_TO', target: 'library', method: null }],
})

const LAZY_EVAL_JSON = JSON.stringify({
  inferred_events: [
    {
      title: 'Merchants arrived',
      summary: 'A caravan of merchants arrived at the market square.',
      state_changes: ['New merchants present in the square'],
    },
  ],
  current_state_description: 'The market is bustling with newly arrived merchants.',
})

// ============================================================
// NPCResponseGenerator Tests
// ============================================================

describe('NPCResponseGenerator', () => {
  let stateStore: InMemoryStateStore
  let loreStore: InMemoryLoreStore
  let longTermMemoryStore: InMemoryLongTermMemoryStore
  let mockProvider: MockLLMProvider
  let runner: AgentRunner
  let generator: NPCResponseGenerator

  beforeEach(async () => {
    stateStore = new InMemoryStateStore()
    loreStore = new InMemoryLoreStore()
    longTermMemoryStore = new InMemoryLongTermMemoryStore()
    mockProvider = new MockLLMProvider()
    mockProvider.setDefault(NPC_RESPONSE_JSON)
    runner = new AgentRunner(mockProvider, { timeout_ms: 5000, max_retries: 1, base_delay_ms: 0 })
    generator = new NPCResponseGenerator(runner, stateStore, loreStore, longTermMemoryStore)
  })

  it('Tier A NPC generates response using profile, memory, and conversation history', async () => {
    const npc_id = 'npc-aldric'
    const session_id = 'sess-1'

    await stateStore.set(`character:${npc_id}:state`, makeTierAState(npc_id))

    // Set up lore profile
    await loreStore.append(makeLoreEntry(npc_id, 'NPC_PERSONAL', 'Aldric is a retired knight.'))
    await loreStore.append(makeLoreEntry(npc_id, 'RELATIONSHIP', 'Aldric distrusts the merchant guild.'))

    // Set up memory buffer
    const buffer: MemoryBuffer = {
      npc_id,
      entries: [
        { event_id: 'evt-100', subjective_summary: 'Heard rumors of bandits.', distortion_type: 'NONE', recorded_at_turn: 10 },
      ],
      max_size: 20,
    }
    await stateStore.set(`character:${npc_id}:memory_buffer`, buffer)

    const result = await generator.generateResponse(npc_id, 'Hello there!', session_id)

    expect(result.npc_id).toBe(npc_id)
    expect(result.response_text).toBe('Greetings, traveler. What brings you here?')

    // Verify state was updated
    const updatedState = await stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)
    expect(updatedState!.current_emotion).toBe('friendly')
    expect(updatedState!.interaction_count).toBe(6) // was 5

    // Verify conversation was appended
    const history = await stateStore.get<{ turns: unknown[] }>(`conversation:${session_id}:${npc_id}`)
    expect(history!.turns.length).toBe(2) // player + NPC
  })

  it('Tier B NPC generates response (simplified, no long-term memory)', async () => {
    const npc_id = 'npc-brenna'
    const session_id = 'sess-2'

    await stateStore.set(`character:${npc_id}:state`, makeTierBState(npc_id))
    await loreStore.append(makeLoreEntry(npc_id, 'NPC_PERSONAL', 'Brenna is a curious scholar.'))

    const result = await generator.generateResponse(npc_id, 'What are you studying?', session_id)

    expect(result.npc_id).toBe(npc_id)
    expect(result.response_text).toBe('Greetings, traveler. What brings you here?')

    // LLM was called (not long-term memory store)
    expect(mockProvider.callCount).toBeGreaterThanOrEqual(1)
  })

  it('Tier C NPC generates response from template', async () => {
    const npc_id = 'npc-guard'

    await stateStore.set(`character:${npc_id}:state`, makeTierCState(npc_id))

    const template: TierCTemplate = {
      template_id: npc_id,
      type: 'guard',
      personality_sketch: 'stoic, duty-bound',
      default_response_style: 'brief and formal',
    }
    await stateStore.set(`npc:template:${npc_id}`, template)

    const result = await generator.generateResponse(npc_id, 'Let me through.', 'sess-3')

    expect(result.npc_id).toBe(npc_id)
    expect(result.response_text).toBe('Greetings, traveler. What brings you here?')
  })

  it('After response: emotion updated, conversation history appended, interaction_count incremented', async () => {
    const npc_id = 'npc-aldric'
    const session_id = 'sess-1'

    await stateStore.set(`character:${npc_id}:state`, makeTierAState(npc_id, { interaction_count: 10 }))
    await loreStore.append(makeLoreEntry(npc_id, 'NPC_PERSONAL', 'Aldric is brave.'))

    await generator.generateResponse(npc_id, 'Tell me about the artifact.', session_id)

    const updatedState = await stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)
    expect(updatedState!.current_emotion).toBe('friendly') // emotion_change from mock
    expect(updatedState!.interaction_count).toBe(11)

    // Conversation history should have 2 turns (player input + NPC response)
    const convManager = new ConversationManager(stateStore)
    const history = await convManager.getHistory(session_id, npc_id)
    expect(history.turns.length).toBe(2)
    expect(history.turns[0].role).toBe('PLAYER')
    expect(history.turns[0].content).toBe('Tell me about the artifact.')
    expect(history.turns[1].role).toBe('NPC')
    expect(history.turns[1].content).toBe('Greetings, traveler. What brings you here?')
  })
})

// ============================================================
// SubjectiveMemoryGenerator Tests
// ============================================================

describe('SubjectiveMemoryGenerator', () => {
  let stateStore: InMemoryStateStore
  let longTermMemoryStore: InMemoryLongTermMemoryStore
  let mockProvider: MockLLMProvider
  let runner: AgentRunner
  let generator: SubjectiveMemoryGenerator

  beforeEach(() => {
    stateStore = new InMemoryStateStore()
    longTermMemoryStore = new InMemoryLongTermMemoryStore()
    mockProvider = new MockLLMProvider()
    mockProvider.setDefault(SUBJECTIVE_MEMORY_JSON)
    runner = new AgentRunner(mockProvider, { timeout_ms: 5000, max_retries: 1, base_delay_ms: 0 })
    generator = new SubjectiveMemoryGenerator(runner, stateStore, longTermMemoryStore)
  })

  it('generates subjective memory for an event', async () => {
    const npc_id = 'npc-aldric'
    await stateStore.set(`character:${npc_id}:state`, makeTierAState(npc_id))

    const event: MemoryEventInput = {
      id: 'evt-200',
      summary: 'A stranger arrived at the tavern asking questions.',
      participant_ids: [npc_id, 'player'],
      location_id: 'tavern',
    }

    await generator.generateMemory(npc_id, event)

    const buffer = await stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
    expect(buffer).not.toBeNull()
    expect(buffer!.entries.length).toBe(1)
    expect(buffer!.entries[0].event_id).toBe('evt-200')
    expect(buffer!.entries[0].subjective_summary).toBe('The stranger seemed trustworthy but I remain cautious.')
    expect(buffer!.entries[0].distortion_type).toBe('NONE')
  })

  it('appends to MemoryBuffer', async () => {
    const npc_id = 'npc-brenna'
    await stateStore.set(`character:${npc_id}:state`, makeTierBState(npc_id))

    // Pre-populate buffer with one entry
    const existingBuffer: MemoryBuffer = {
      npc_id,
      entries: [
        { event_id: 'evt-100', subjective_summary: 'Old memory', distortion_type: 'NONE', recorded_at_turn: 5 },
      ],
      max_size: 5,
    }
    await stateStore.set(`character:${npc_id}:memory_buffer`, existingBuffer)

    const event: MemoryEventInput = {
      id: 'evt-201',
      summary: 'Brenna witnessed a theft.',
      participant_ids: [npc_id, 'thief'],
      location_id: 'market',
    }

    await generator.generateMemory(npc_id, event)

    const buffer = await stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
    expect(buffer!.entries.length).toBe(2)
    expect(buffer!.entries[1].event_id).toBe('evt-201')
  })

  it('MemoryBuffer overflow: Tier A evicts to long-term memory store', async () => {
    const npc_id = 'npc-aldric'
    await stateStore.set(`character:${npc_id}:state`, makeTierAState(npc_id))

    // Fill buffer to max_size (20 for Tier A)
    const entries = Array.from({ length: 20 }, (_, i) => ({
      event_id: `evt-fill-${i}`,
      subjective_summary: `Memory ${i}`,
      distortion_type: 'NONE' as const,
      recorded_at_turn: i,
    }))
    const fullBuffer: MemoryBuffer = { npc_id, entries, max_size: 20 }
    await stateStore.set(`character:${npc_id}:memory_buffer`, fullBuffer)

    const event: MemoryEventInput = {
      id: 'evt-overflow',
      summary: 'Overflow event',
      participant_ids: [npc_id],
      location_id: 'tavern',
    }

    await generator.generateMemory(npc_id, event)

    const buffer = await stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
    expect(buffer!.entries.length).toBe(20) // still at max
    expect(buffer!.entries[0].event_id).toBe('evt-fill-1') // oldest evicted

    // Evicted entry should be in long-term memory
    const ltMemories = await longTermMemoryStore.findRecent(npc_id, 10)
    expect(ltMemories.length).toBe(1)
    expect(ltMemories[0].event_id).toBe('evt-fill-0')
    expect(ltMemories[0].subjective_summary).toBe('Memory 0')
  })

  it('MemoryBuffer overflow: Tier B discards oldest', async () => {
    const npc_id = 'npc-brenna'
    await stateStore.set(`character:${npc_id}:state`, makeTierBState(npc_id))

    // Fill buffer to max_size (5 for Tier B)
    const entries = Array.from({ length: 5 }, (_, i) => ({
      event_id: `evt-fill-${i}`,
      subjective_summary: `Memory ${i}`,
      distortion_type: 'NONE' as const,
      recorded_at_turn: i,
    }))
    const fullBuffer: MemoryBuffer = { npc_id, entries, max_size: 5 }
    await stateStore.set(`character:${npc_id}:memory_buffer`, fullBuffer)

    const event: MemoryEventInput = {
      id: 'evt-overflow-b',
      summary: 'Overflow for tier B',
      participant_ids: [npc_id],
      location_id: 'market',
    }

    await generator.generateMemory(npc_id, event)

    const buffer = await stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
    expect(buffer!.entries.length).toBe(5) // still at max
    expect(buffer!.entries[0].event_id).toBe('evt-fill-1') // oldest evicted

    // Tier B should NOT write to long-term memory
    const ltMemories = await longTermMemoryStore.findRecent(npc_id, 10)
    expect(ltMemories.length).toBe(0)
  })
})

// ============================================================
// NPCTierManager Tests
// ============================================================

describe('NPCTierManager', () => {
  let stateStore: InMemoryStateStore
  let tierManager: NPCTierManager

  beforeEach(() => {
    stateStore = new InMemoryStateStore()
    tierManager = new NPCTierManager(stateStore)
  })

  it('C→B upgrade when interaction_count >= 3', async () => {
    const npc_id = 'npc-guard'
    await stateStore.set(`character:${npc_id}:state`, makeTierCState(npc_id, { interaction_count: 3 }))

    const upgraded = await tierManager.checkUpgrade(npc_id)

    expect(upgraded).toBe(true)

    const state = await stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)
    expect(state!.tier).toBe('B')

    // Memory buffer should be created with max_size=5
    const buffer = await stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
    expect(buffer).not.toBeNull()
    expect(buffer!.max_size).toBe(5)
    expect(buffer!.entries.length).toBe(0)
  })

  it('No upgrade when count < 3', async () => {
    const npc_id = 'npc-guard'
    await stateStore.set(`character:${npc_id}:state`, makeTierCState(npc_id, { interaction_count: 2 }))

    const upgraded = await tierManager.checkUpgrade(npc_id)

    expect(upgraded).toBe(false)

    const state = await stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)
    expect(state!.tier).toBe('C')
  })

  it('B→B-lite when inactive > 50 turns', async () => {
    const npc_id = 'npc-brenna'
    await stateStore.set(`character:${npc_id}:state`, makeTierBState(npc_id))

    // Set up lite mode flag with last interaction at turn 0
    await stateStore.set(`npc:lite_mode:${npc_id}`, {
      is_lite: false,
      last_interaction_turn: 0,
    })

    // Set up memory buffer with multiple entries
    const buffer: MemoryBuffer = {
      npc_id,
      entries: [
        { event_id: 'e1', subjective_summary: 'Memory one.', distortion_type: 'NONE', recorded_at_turn: 1 },
        { event_id: 'e2', subjective_summary: 'Memory two.', distortion_type: 'NONE', recorded_at_turn: 2 },
        { event_id: 'e3', subjective_summary: 'Memory three.', distortion_type: 'NONE', recorded_at_turn: 3 },
      ],
      max_size: 5,
    }
    await stateStore.set(`character:${npc_id}:memory_buffer`, buffer)

    const downgraded = await tierManager.checkDowngrade(npc_id, 51) // 51 - 0 = 51 > 50

    expect(downgraded).toBe(true)

    const liteFlag = await stateStore.get<{ is_lite: boolean }>(`npc:lite_mode:${npc_id}`)
    expect(liteFlag!.is_lite).toBe(true)

    // Memory buffer should be compressed to single entry
    const compressedBuffer = await stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
    expect(compressedBuffer!.entries.length).toBe(1)
    expect(compressedBuffer!.entries[0].event_id).toBe('compressed')
    expect(compressedBuffer!.entries[0].subjective_summary).toContain('Memory one.')
    expect(compressedBuffer!.entries[0].subjective_summary).toContain('Memory three.')
  })

  it('B-lite restored on interaction', async () => {
    const npc_id = 'npc-brenna'
    await stateStore.set(`character:${npc_id}:state`, makeTierBState(npc_id))
    await stateStore.set(`npc:lite_mode:${npc_id}`, {
      is_lite: true,
      last_interaction_turn: 10,
    })

    await tierManager.restoreFromLite(npc_id)

    const liteFlag = await stateStore.get<{ is_lite: boolean }>(`npc:lite_mode:${npc_id}`)
    expect(liteFlag!.is_lite).toBe(false)
  })

  it('promoteTierA creates Tier A with goals', async () => {
    const npc_id = 'npc-brenna'
    await stateStore.set(`character:${npc_id}:state`, makeTierBState(npc_id))

    const goals = [
      {
        id: 'goal-promo-1',
        description: 'Investigate the ruins',
        priority: 7,
        created_from_event_id: null,
        status: 'IN_PROGRESS' as const,
      },
    ]

    await tierManager.promoteTierA(npc_id, goals)

    const state = await stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)
    expect(state!.tier).toBe('A')
    expect(state!.goal_queue.length).toBe(1)
    expect(state!.goal_queue[0].description).toBe('Investigate the ruins')

    // Memory buffer should be upgraded to max_size=20
    const buffer = await stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
    expect(buffer).not.toBeNull()
    expect(buffer!.max_size).toBe(20)
  })
})

// ============================================================
// ConversationManager Tests
// ============================================================

describe('ConversationManager', () => {
  let stateStore: InMemoryStateStore
  let convManager: ConversationManager

  beforeEach(() => {
    stateStore = new InMemoryStateStore()
    convManager = new ConversationManager(stateStore)
  })

  it('appends turns and retrieves history', async () => {
    const session_id = 'sess-1'
    const npc_id = 'npc-aldric'

    await convManager.appendTurn(session_id, npc_id, 'PLAYER', 'Hello!', 1)
    await convManager.appendTurn(session_id, npc_id, 'NPC', 'Greetings.', 2)
    await convManager.appendTurn(session_id, npc_id, 'PLAYER', 'How are you?', 3)

    const history = await convManager.getHistory(session_id, npc_id)

    expect(history.session_id).toBe(session_id)
    expect(history.npc_id).toBe(npc_id)
    expect(history.turns.length).toBe(3)
    expect(history.turns[0]).toEqual({ role: 'PLAYER', content: 'Hello!', turn_number: 1 })
    expect(history.turns[2]).toEqual({ role: 'PLAYER', content: 'How are you?', turn_number: 3 })
  })

  it('compression when exceeding max_turns', async () => {
    const session_id = 'sess-compress'
    const npc_id = 'npc-verbose'

    // max_turns defaults to 20; add 22 turns to exceed it
    for (let i = 1; i <= 22; i++) {
      const role = i % 2 === 1 ? 'PLAYER' : 'NPC'
      await convManager.appendTurn(session_id, npc_id, role as 'PLAYER' | 'NPC', `Turn ${i}`, i)
    }

    // Verify we have 22 turns
    let history = await convManager.getHistory(session_id, npc_id)
    expect(history.turns.length).toBe(22)

    // Compress
    await convManager.compressIfNeeded(session_id, npc_id)

    history = await convManager.getHistory(session_id, npc_id)

    // keepFirst=2, keepLast=3, plus 1 summary turn = 6
    expect(history.turns.length).toBe(6)

    // First 2 original turns preserved
    expect(history.turns[0].content).toBe('Turn 1')
    expect(history.turns[1].content).toBe('Turn 2')

    // Summary turn in the middle
    expect(history.turns[2].content).toContain('省略')

    // Last 3 original turns preserved
    expect(history.turns[3].content).toBe('Turn 20')
    expect(history.turns[4].content).toBe('Turn 21')
    expect(history.turns[5].content).toBe('Turn 22')
  })
})

// ============================================================
// AgentScheduler Tests
// ============================================================

describe('AgentScheduler', () => {
  let stateStore: InMemoryStateStore
  let mockProvider: MockLLMProvider
  let runner: AgentRunner
  let intentGenerator: NPCIntentGenerator
  let tierManager: NPCTierManager
  let scheduler: AgentScheduler

  beforeEach(() => {
    stateStore = new InMemoryStateStore()
    mockProvider = new MockLLMProvider()
    mockProvider.setDefault(NPC_INTENT_JSON)
    runner = new AgentRunner(mockProvider, { timeout_ms: 5000, max_retries: 1, base_delay_ms: 0 })
    intentGenerator = new NPCIntentGenerator(runner, stateStore)
    tierManager = new NPCTierManager(stateStore)
    scheduler = new AgentScheduler(stateStore, intentGenerator, tierManager)
  })

  it('generates intents for Tier A NPCs with IN_PROGRESS goals', async () => {
    const npc_id = 'npc-aldric'
    await stateStore.set(`character:${npc_id}:state`, makeTierAState(npc_id, { is_active: false }))

    const intents = await scheduler.runEndOfTurn(10, null)

    expect(intents.length).toBe(1)
    expect(intents[0].npc_id).toBe(npc_id)
    expect(intents[0].intent).toBe('Search the old library for clues about the artifact')
    expect(intents[0].actions.length).toBe(1)
    expect(intents[0].actions[0].type).toBe('MOVE_TO')
  })

  it('skips active NPCs (in conversation)', async () => {
    const npc_id = 'npc-aldric'
    await stateStore.set(`character:${npc_id}:state`, makeTierAState(npc_id, { is_active: false }))

    // Pass npc_id as the active NPC
    const intents = await scheduler.runEndOfTurn(10, npc_id)

    expect(intents.length).toBe(0)
  })

  it('checks upgrades/downgrades during end-of-turn', async () => {
    // Tier C NPC ready for upgrade
    const npc_c = 'npc-guard'
    await stateStore.set(`character:${npc_c}:state`, makeTierCState(npc_c, { interaction_count: 5 }))

    // Tier B NPC ready for downgrade
    const npc_b = 'npc-merchant'
    await stateStore.set(`character:${npc_b}:state`, makeTierBState(npc_b))
    await stateStore.set(`npc:lite_mode:${npc_b}`, { is_lite: false, last_interaction_turn: 0 })

    await scheduler.runEndOfTurn(100, null)

    // Guard should be upgraded to B
    const guardState = await stateStore.get<CharacterDynamicState>(`character:${npc_c}:state`)
    expect(guardState!.tier).toBe('B')

    // Merchant should be in lite mode
    const liteFlag = await stateStore.get<{ is_lite: boolean }>(`npc:lite_mode:${npc_b}`)
    expect(liteFlag!.is_lite).toBe(true)
  })
})

// ============================================================
// WorldAgent Tests
// ============================================================

describe('WorldAgent', () => {
  let stateStore: InMemoryStateStore
  let eventStore: InMemoryEventStore
  let mockProvider: MockLLMProvider
  let runner: AgentRunner
  let worldAgent: WorldAgent

  beforeEach(async () => {
    stateStore = new InMemoryStateStore()
    eventStore = new InMemoryEventStore()
    mockProvider = new MockLLMProvider()
    mockProvider.setDefault(LAZY_EVAL_JSON)
    runner = new AgentRunner(mockProvider, { timeout_ms: 5000, max_retries: 1, base_delay_ms: 0 })
    worldAgent = new WorldAgent(stateStore, eventStore, runner)

    // Set up game time
    const gameTime: GameTime = {
      current: { day: 1, hour: 8, turn: 10 },
      total_turns: 10,
    }
    await stateStore.set('world:game_time', gameTime)
  })

  it('applyStateChanges updates location state with causal chain', async () => {
    const locationId = 'tavern'
    await stateStore.set(`world:location:${locationId}`, makeLocationState(locationId))

    const stateChanges: StateChange[] = [
      {
        target: `world:location:${locationId}`,
        field: 'current_status',
        change_description: 'A brawl broke out in the tavern.',
      },
    ]

    await worldAgent.applyStateChanges('evt-300', stateChanges, { day: 1, hour: 8, turn: 10 })

    const locState = await stateStore.get<LocationState>(`world:location:${locationId}`)
    expect(locState!.current_status).toBe('A brawl broke out in the tavern.')
    expect(locState!.causal_chain.length).toBe(1)
    expect(locState!.causal_chain[0].caused_by_event_id).toBe('evt-300')
    expect(locState!.causal_chain[0].before_status).toBe('peaceful')
    expect(locState!.causal_chain[0].after_status).toBe('A brawl broke out in the tavern.')
  })

  it('idempotent: same event_id does not apply twice', async () => {
    const locationId = 'tavern'
    await stateStore.set(`world:location:${locationId}`, makeLocationState(locationId))

    const stateChanges: StateChange[] = [
      {
        target: `world:location:${locationId}`,
        field: 'current_status',
        change_description: 'A brawl broke out.',
      },
    ]

    await worldAgent.applyStateChanges('evt-idem', stateChanges, { day: 1, hour: 8, turn: 10 })
    await worldAgent.applyStateChanges('evt-idem', stateChanges, { day: 1, hour: 8, turn: 10 })

    const locState = await stateStore.get<LocationState>(`world:location:${locationId}`)
    expect(locState!.causal_chain.length).toBe(1) // only one entry, not two
  })

  it('advanceGameTime increments total_turns', async () => {
    await worldAgent.advanceGameTime()

    const gameTime = await stateStore.get<GameTime>('world:game_time')
    expect(gameTime!.total_turns).toBe(11)
    expect(gameTime!.current.turn).toBe(11)
  })

  it('checkAndEvaluate on frozen location triggers lazy evaluation', async () => {
    const locationId = 'abandoned-mine'
    await stateStore.set(
      `world:location:${locationId}`,
      makeLocationState(locationId, {
        is_frozen: true,
        last_observed_turn: 5,
        current_status: 'Dark and quiet.',
      }),
    )

    await worldAgent.checkAndEvaluate(locationId, 'LOCATION', 15)

    const locState = await stateStore.get<LocationState>(`world:location:${locationId}`)
    expect(locState!.is_frozen).toBe(false)
    expect(locState!.last_observed_turn).toBe(15)
    expect(locState!.current_status).toBe('The market is bustling with newly arrived merchants.')

    // Verify inferred events were written to event store
    const allEvents = await eventStore.getAllTier1()
    expect(allEvents.length).toBe(1)
    expect(allEvents[0].title).toBe('Merchants arrived')
    expect(allEvents[0].tags).toContain('INFERRED')
  })

  it('checkAndEvaluate on non-frozen location is a no-op', async () => {
    const locationId = 'tavern'
    await stateStore.set(
      `world:location:${locationId}`,
      makeLocationState(locationId, { is_frozen: false, last_observed_turn: 10 }),
    )

    await worldAgent.checkAndEvaluate(locationId, 'LOCATION', 15)

    // LLM should not have been called
    expect(mockProvider.callCount).toBe(0)

    const locState = await stateStore.get<LocationState>(`world:location:${locationId}`)
    expect(locState!.is_frozen).toBe(false)
    expect(locState!.last_observed_turn).toBe(10) // unchanged
  })

  it('freezeTarget and unfreezeTarget work correctly', async () => {
    const locationId = 'market'
    await stateStore.set(
      `world:location:${locationId}`,
      makeLocationState(locationId, { is_frozen: false, last_observed_turn: 5 }),
    )

    // Freeze
    await worldAgent.freezeTarget(locationId, 10)

    let locState = await stateStore.get<LocationState>(`world:location:${locationId}`)
    expect(locState!.is_frozen).toBe(true)
    expect(locState!.last_observed_turn).toBe(10)

    // Unfreeze (triggers lazy eval since it's frozen)
    await worldAgent.unfreezeTarget(locationId, 20)

    locState = await stateStore.get<LocationState>(`world:location:${locationId}`)
    expect(locState!.is_frozen).toBe(false)
    expect(locState!.last_observed_turn).toBe(20)
  })
})
