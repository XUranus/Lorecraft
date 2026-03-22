import { describe, it, expect, beforeEach } from 'vitest'
import { SignalProcessor } from './signal-processor.js'
import { LocationGraph } from './location-graph.js'
import { InsistenceStateMachine } from './insistence-state-machine.js'
import { InMemoryStateStore } from '../../infrastructure/storage/state-store.js'
import type { TraitConfig } from '../models/trait.js'
import type { LocationEdge } from '../models/world.js'

// ============================================================
// SignalProcessor
// ============================================================

describe('SignalProcessor', () => {
  let store: InMemoryStateStore
  let processor: SignalProcessor

  const configs: TraitConfig[] = [
    {
      trait_id: 'sarcastic',
      trait_type: 'EXPRESSION',
      display_name: '戏谑',
      voice_description: '以讽刺方式发言',
      threshold_active: 0.7,
      threshold_silent: 0.2,
      hysteresis_band: 0.05,
      decay_rate: 0.95,
      signal_mapping: { sarcasm: 1.0, serious: -0.5 },
    },
    {
      trait_id: 'ruthless',
      trait_type: 'VALUE',
      display_name: '无情',
      voice_description: '冷酷无情的声音',
      threshold_active: 0.6,
      threshold_silent: 0.15,
      hysteresis_band: 0.05,
      decay_rate: 0.9,
      signal_mapping: { hostility: 0.8, contempt: 0.6 },
    },
  ]

  beforeEach(async () => {
    store = new InMemoryStateStore()
    processor = new SignalProcessor(store, configs)
    // Initialize weights
    await store.set('player:traits:sarcastic', {
      trait_id: 'sarcastic',
      trait_type: 'EXPRESSION',
      current_weight: 0,
      last_updated_turn: 0,
    })
    await store.set('player:traits:ruthless', {
      trait_id: 'ruthless',
      trait_type: 'VALUE',
      current_weight: 0,
      last_updated_turn: 0,
    })
  })

  it('returns no active traits when all weights are zero', async () => {
    const active = await processor.getActiveTraits()
    expect(active).toHaveLength(0)
  })

  it('applySignalA increases weight via signal mapping', async () => {
    await processor.applySignalA({ sarcasm: 0.8 })
    const weight = await store.get<{ current_weight: number }>('player:traits:sarcastic')
    expect(weight!.current_weight).toBeGreaterThan(0)
  })

  it('applySignalA can decrease weight with negative mapping', async () => {
    // First increase
    await store.set('player:traits:sarcastic', {
      trait_id: 'sarcastic',
      trait_type: 'EXPRESSION',
      current_weight: 0.5,
      last_updated_turn: 0,
    })
    await processor.applySignalA({ serious: 1.0 })
    const weight = await store.get<{ current_weight: number }>('player:traits:sarcastic')
    // 0.5 + (1.0 * -0.5) = 0.0 (clamped)
    expect(weight!.current_weight).toBeLessThanOrEqual(0.5)
  })

  it('weight never goes below zero', async () => {
    await processor.applySignalA({ serious: 10.0 })
    const weight = await store.get<{ current_weight: number }>('player:traits:sarcastic')
    expect(weight!.current_weight).toBe(0)
  })

  it('getTraitStatus returns correct status based on weight', async () => {
    // SILENT: weight = 0
    expect(await processor.getTraitStatus('sarcastic')).toBe('SILENT')

    // Set to ACTIVE range
    await store.set('player:traits:sarcastic', {
      trait_id: 'sarcastic',
      trait_type: 'EXPRESSION',
      current_weight: 0.8,
      last_updated_turn: 1,
    })
    expect(await processor.getTraitStatus('sarcastic')).toBe('ACTIVE')

    // EMERGING range (between threshold_active - hysteresis and threshold_active)
    await store.set('player:traits:sarcastic', {
      trait_id: 'sarcastic',
      trait_type: 'EXPRESSION',
      current_weight: 0.67,
      last_updated_turn: 1,
    })
    expect(await processor.getTraitStatus('sarcastic')).toBe('EMERGING')
  })

  it('getActiveTraits returns ACTIVE and EMERGING traits', async () => {
    await store.set('player:traits:sarcastic', {
      trait_id: 'sarcastic',
      trait_type: 'EXPRESSION',
      current_weight: 0.8,
      last_updated_turn: 1,
    })
    const active = await processor.getActiveTraits()
    expect(active.length).toBeGreaterThan(0)
    expect(active[0].trait_id).toBe('sarcastic')
  })

  it('applySignalB applies with multiplier', async () => {
    await processor.applySignalB({ ruthless: 0.5 })
    const weight = await store.get<{ current_weight: number }>('player:traits:ruthless')
    // 0 + 0.5 * 1.5 = 0.75
    expect(weight!.current_weight).toBe(0.75)
  })

  it('decayAllWeights reduces weights', async () => {
    await store.set('player:traits:sarcastic', {
      trait_id: 'sarcastic',
      trait_type: 'EXPRESSION',
      current_weight: 1.0,
      last_updated_turn: 0,
    })
    await processor.decayAllWeights(5)
    const weight = await store.get<{ current_weight: number }>('player:traits:sarcastic')
    // 1.0 * 0.95^5 ≈ 0.7738
    expect(weight!.current_weight).toBeCloseTo(Math.pow(0.95, 5), 4)
  })
})

// ============================================================
// LocationGraph
// ============================================================

describe('LocationGraph', () => {
  const edges: LocationEdge[] = [
    {
      from_location_id: 'market',
      to_location_id: 'police',
      traversal_condition: 'OPEN',
      condition_detail: null,
      travel_time_turns: 1,
    },
    {
      from_location_id: 'police',
      to_location_id: 'office',
      traversal_condition: 'REQUIRES_KEY',
      condition_detail: 'key_office',
      travel_time_turns: 0,
    },
    {
      from_location_id: 'market',
      to_location_id: 'dock',
      traversal_condition: 'BLOCKED',
      condition_detail: null,
      travel_time_turns: 2,
    },
  ]

  let graph: LocationGraph

  beforeEach(() => {
    graph = new LocationGraph(edges)
  })

  it('finds reachable path', () => {
    const result = graph.isReachable('market', 'police', {
      playerHasKey: () => false,
      eventHasOccurred: () => false,
    })
    expect(result.reachable).toBe(true)
    if (result.reachable) {
      expect(result.total_travel_turns).toBe(1)
    }
  })

  it('blocks path with BLOCKED condition', () => {
    const result = graph.isReachable('market', 'dock', {
      playerHasKey: () => false,
      eventHasOccurred: () => false,
    })
    expect(result.reachable).toBe(false)
  })

  it('blocks path requiring key when player has no key', () => {
    const result = graph.isReachable('market', 'office', {
      playerHasKey: () => false,
      eventHasOccurred: () => false,
    })
    expect(result.reachable).toBe(false)
  })

  it('allows path requiring key when player has key', () => {
    const result = graph.isReachable('market', 'office', {
      playerHasKey: (key) => key === 'key_office',
      eventHasOccurred: () => false,
    })
    expect(result.reachable).toBe(true)
    if (result.reachable) {
      expect(result.total_travel_turns).toBe(1) // market→police(1) + police→office(0)
    }
  })

  it('returns not reachable for disconnected nodes', () => {
    const result = graph.isReachable('market', 'nonexistent', {
      playerHasKey: () => false,
      eventHasOccurred: () => false,
    })
    expect(result.reachable).toBe(false)
  })

  it('undirected: can traverse in reverse', () => {
    const result = graph.isReachable('police', 'market', {
      playerHasKey: () => false,
      eventHasOccurred: () => false,
    })
    expect(result.reachable).toBe(true)
  })

  it('getNeighbors returns adjacent locations', () => {
    const neighbors = graph.getNeighbors('market')
    expect(neighbors).toContain('police')
    expect(neighbors).toContain('dock')
  })

  it('addEdge extends the graph', () => {
    graph.addEdge({
      from_location_id: 'dock',
      to_location_id: 'warehouse',
      traversal_condition: 'OPEN',
      condition_detail: null,
      travel_time_turns: 1,
    })
    expect(graph.getNeighbors('dock')).toContain('warehouse')
  })

  it('updateEdge modifies traversal condition', () => {
    graph.updateEdge('market', 'dock', { traversal_condition: 'OPEN' })
    const result = graph.isReachable('market', 'dock', {
      playerHasKey: () => false,
      eventHasOccurred: () => false,
    })
    expect(result.reachable).toBe(true)
  })
})

// ============================================================
// InsistenceStateMachine
// ============================================================

describe('InsistenceStateMachine', () => {
  let sm: InsistenceStateMachine

  beforeEach(() => {
    sm = new InsistenceStateMachine()
  })

  it('starts in NORMAL state', () => {
    expect(sm.getState()).toBe('NORMAL')
    expect(sm.getForceLevel()).toBe(0)
  })

  it('transitions NORMAL → WARNED on reflection block', () => {
    sm.onReflectionBlock('intent_abc')
    expect(sm.getState()).toBe('WARNED')
  })

  it('transitions WARNED → INSISTING on same intent', () => {
    sm.onReflectionBlock('intent_abc')
    sm.onPlayerInput('intent_abc')
    expect(sm.getState()).toBe('INSISTING')
    expect(sm.getForceLevel()).toBe(1)
  })

  it('transitions WARNED → INSISTING with force_level=2 on explicit insistence', () => {
    sm.onReflectionBlock('intent_abc')
    sm.onPlayerInput('intent_abc', true)
    expect(sm.getState()).toBe('INSISTING')
    expect(sm.getForceLevel()).toBe(2)
  })

  it('transitions WARNED → NORMAL on different intent', () => {
    sm.onReflectionBlock('intent_abc')
    sm.onPlayerInput('intent_xyz')
    expect(sm.getState()).toBe('NORMAL')
    expect(sm.getForceLevel()).toBe(0)
  })

  it('reset returns to NORMAL', () => {
    sm.onReflectionBlock('intent_abc')
    sm.onPlayerInput('intent_abc')
    expect(sm.getState()).toBe('INSISTING')
    sm.reset()
    expect(sm.getState()).toBe('NORMAL')
    expect(sm.getForceLevel()).toBe(0)
  })
})
