import { describe, it, expect } from 'vitest'
import {
  GameTimestampSchema,
  EventWeight,
  EventTag,
  NPCTier,
  TraitType,
  TraitStatus,
} from './common.js'
import { EventSchema, EventTier1Schema } from './event.js'
import { LocationStateSchema, LocationEdgeSchema } from './world.js'
import { CharacterDynamicStateSchema, MemoryBufferSchema } from './character.js'
import { LoreEntrySchema } from './lore.js'
import { TraitWeightSchema, TraitConfigSchema } from './trait.js'
import { GenesisDocumentSchema } from './genesis.js'

describe('GameTimestamp', () => {
  it('validates a correct timestamp', () => {
    const result = GameTimestampSchema.safeParse({ day: 1, hour: 14, turn: 3 })
    expect(result.success).toBe(true)
  })

  it('rejects negative day', () => {
    const result = GameTimestampSchema.safeParse({ day: -1, hour: 14, turn: 3 })
    expect(result.success).toBe(false)
  })

  it('rejects hour > 23', () => {
    const result = GameTimestampSchema.safeParse({ day: 1, hour: 25, turn: 0 })
    expect(result.success).toBe(false)
  })
})

describe('Enums', () => {
  it('validates EventWeight', () => {
    expect(EventWeight.safeParse('MAJOR').success).toBe(true)
    expect(EventWeight.safeParse('INVALID').success).toBe(false)
  })

  it('validates EventTag', () => {
    expect(EventTag.safeParse('DIALOGUE').success).toBe(true)
    expect(EventTag.safeParse('INFERRED').success).toBe(true)
    expect(EventTag.safeParse('COMBAT').success).toBe(false)
  })

  it('validates NPCTier', () => {
    expect(NPCTier.safeParse('A').success).toBe(true)
    expect(NPCTier.safeParse('D').success).toBe(false)
  })

  it('validates TraitType and TraitStatus', () => {
    expect(TraitType.safeParse('EXPRESSION').success).toBe(true)
    expect(TraitStatus.safeParse('EMERGING').success).toBe(true)
  })
})

describe('Event Schema', () => {
  const validTier1 = {
    id: 'evt_001',
    title: '对峙警察局长',
    timestamp: { day: 1, hour: 14, turn: 3 },
    location_id: 'loc_police_station',
    participant_ids: ['player', 'npc_chief'],
    tags: ['DIALOGUE', 'CONFLICT'],
    weight: 'SIGNIFICANT',
    force_level: 0,
    created_at: Date.now(),
  }

  it('validates Tier 1', () => {
    expect(EventTier1Schema.safeParse(validTier1).success).toBe(true)
  })

  it('validates full Event', () => {
    const fullEvent = {
      ...validTier1,
      summary: '玩家在警察局与局长对峙',
      choice_signals: { 'confrontational': 0.8 },
      context: '玩家已收集到腐败证据',
      related_event_ids: [],
      state_snapshot: {
        location_state: '警察局大厅',
        participant_states: { npc_chief: '紧张' },
      },
      narrative_text: '你走进局长办公室……',
    }
    expect(EventSchema.safeParse(fullEvent).success).toBe(true)
  })

  it('rejects invalid force_level', () => {
    const bad = { ...validTier1, force_level: 3 }
    expect(EventTier1Schema.safeParse(bad).success).toBe(false)
  })
})

describe('LocationState Schema', () => {
  it('validates a location', () => {
    const loc = {
      id: 'loc_market',
      name: '中心市场',
      region_id: 'region_downtown',
      current_status: '繁忙的露天市场',
      accessibility: 'OPEN',
      current_occupant_ids: ['npc_vendor'],
      is_frozen: false,
      last_observed_turn: 5,
      causal_chain: [],
    }
    expect(LocationStateSchema.safeParse(loc).success).toBe(true)
  })
})

describe('LocationEdge Schema', () => {
  it('validates an edge', () => {
    const edge = {
      from_location_id: 'loc_market',
      to_location_id: 'loc_police',
      traversal_condition: 'OPEN',
      condition_detail: null,
      travel_time_turns: 0,
    }
    expect(LocationEdgeSchema.safeParse(edge).success).toBe(true)
  })
})

describe('CharacterDynamicState Schema', () => {
  it('validates a character state', () => {
    const state = {
      npc_id: 'npc_chief',
      tier: 'A',
      current_emotion: '焦虑而警惕',
      current_location_id: 'loc_police',
      interaction_count: 5,
      is_active: false,
      goal_queue: [
        {
          id: 'goal_001',
          description: '隐藏腐败证据',
          priority: 8,
          created_from_event_id: null,
          status: 'IN_PROGRESS',
        },
      ],
    }
    expect(CharacterDynamicStateSchema.safeParse(state).success).toBe(true)
  })
})

describe('LoreEntry Schema', () => {
  it('validates a lore entry', () => {
    const lore = {
      id: 'lore_001',
      content: '局长和黑帮有秘密交易',
      fact_type: 'RELATIONSHIP',
      authority_level: 'AI_CANONICALIZED',
      subject_ids: ['npc_chief', 'faction_gang'],
      source_event_id: 'evt_001',
      created_at_turn: 10,
      causal_chain: [],
      related_lore_ids: [],
      content_hash: 'abc123',
    }
    expect(LoreEntrySchema.safeParse(lore).success).toBe(true)
  })
})

describe('TraitWeight Schema', () => {
  it('validates a trait weight', () => {
    const tw = {
      trait_id: 'trait_confrontational',
      trait_type: 'EXPRESSION',
      current_weight: 0.75,
      last_updated_turn: 5,
    }
    expect(TraitWeightSchema.safeParse(tw).success).toBe(true)
  })

  it('rejects negative weight', () => {
    const tw = {
      trait_id: 'trait_x',
      trait_type: 'VALUE',
      current_weight: -0.5,
      last_updated_turn: 1,
    }
    expect(TraitWeightSchema.safeParse(tw).success).toBe(false)
  })
})

describe('TraitConfig Schema', () => {
  it('validates a trait config', () => {
    const tc = {
      trait_id: 'trait_sarcastic',
      trait_type: 'EXPRESSION',
      display_name: '戏谑',
      voice_description: '以讽刺和戏谑的方式发言',
      threshold_active: 0.7,
      threshold_silent: 0.2,
      hysteresis_band: 0.05,
      decay_rate: 0.95,
      signal_mapping: { sarcastic: 1.0, serious: -0.3 },
    }
    expect(TraitConfigSchema.safeParse(tc).success).toBe(true)
  })
})

describe('GenesisDocument Schema', () => {
  it('rejects document with fewer than 3 Tier A NPCs', () => {
    const doc = {
      id: 'gen_001',
      created_at: Date.now(),
      world_setting: {
        background: 'test',
        tone: 'test',
        core_conflict: 'test',
        hidden_secrets: [],
        factions: [],
      },
      narrative_structure: {
        final_goal_description: 'test',
        inciting_event: {
          title: 'test',
          description: 'test',
          location_id: 'loc_1',
          participant_ids: ['player'],
          narrative_text: 'test',
        },
        phases: [{ phase_id: 'p1', description: 'test', direction_summary: 'test' }],
      },
      characters: {
        player_character: { id: 'player', name: '主角', background: 'test' },
        tier_a_npcs: [
        ],
        tier_b_npcs: [],
      },
      initial_locations: [
        { id: 'loc_1', name: 'L1', region_id: 'r1', description: 't', initial_status: 't', connections: [] },
      ],
    }
    const result = GenesisDocumentSchema.safeParse(doc)
    expect(result.success).toBe(false)
  })
})
