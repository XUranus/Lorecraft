import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ActionArbiterStep } from './arbitration-steps.js'
import type { AttributeCheckResult } from './arbitration-steps.js'
import { createPipelineContext } from '../pipeline/types.js'
import type { PipelineContext } from '../pipeline/types.js'
import type { Action } from '../../domain/models/pipeline-io.js'

// Minimal mock for AgentRunner — predetermined checks skip LLM entirely
const mockAgentRunner = {} as any

function makeContext(roll: number): { ctx: PipelineContext; input: Action } {
  // Math.random() → [0,1), roll = floor(random*100)+1
  // To get roll=R, we need floor(random*100)+1=R → random = (R-1)/100
  vi.spyOn(Math, 'random').mockReturnValue((roll - 1) / 100)

  const ctx = createPipelineContext('s1', 'player1', 1, { action_arbiter: true })
  ctx.data.set('player_attributes', {
    strength: 50,
    constitution: 50,
    agility: 50,
    intelligence: 50,
    perception: 50,
    willpower: 50,
    charisma: 50,
    luck: 50,
  })
  ctx.data.set('predetermined_check', { attribute_id: 'charisma', difficulty: 'ROUTINE' })

  const input: Action = { type: 'TALK', target: 'npc1', method: null }

  return { ctx, input }
}

describe('Critical Outcomes', () => {
  let step: ActionArbiterStep

  beforeEach(() => {
    step = new ActionArbiterStep(mockAgentRunner)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('roll >= 95 → CRITICAL_SUCCESS even if total < target', async () => {
    // roll=95, attr=50, total=145; ROUTINE target range [70,90]
    // With mocked random for target too, but critical overrides regardless
    // We need two random calls: one for rollTarget, one for the roll itself
    // rollTarget: min + floor(random * (max-min+1))
    // For ROUTINE [70,90]: 70 + floor(random*21)
    // Let's make target very high by using a second mock
    let callCount = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++
      if (callCount === 1) return 0.99 // rollTarget: 70+floor(0.99*21)=70+20=90
      return (95 - 1) / 100 // roll: floor(0.94*100)+1=95
    })

    const ctx = createPipelineContext('s1', 'player1', 1, { action_arbiter: true })
    // Set low attribute so total < target without critical
    ctx.data.set('player_attributes', {
      strength: 1, constitution: 1, agility: 1, intelligence: 1,
      perception: 1, willpower: 1, charisma: 1, luck: 50,
    })
    ctx.data.set('predetermined_check', { attribute_id: 'charisma', difficulty: 'ROUTINE' })

    const input: Action = { type: 'TALK', target: 'npc1', method: null }
    await step.execute(input, ctx)

    const check = ctx.data.get('attribute_check') as AttributeCheckResult
    expect(check.outcome).toBe('CRITICAL_SUCCESS')
    expect(check.passed).toBe(true)
    expect(check.roll).toBe(95)
    expect(check.margin).toBeDefined()
  })

  it('roll <= 5 → CRITICAL_FAILURE even if total > target', async () => {
    let callCount = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++
      if (callCount === 1) return 0.0 // rollTarget: 70+0=70 (lowest ROUTINE target)
      return (3 - 1) / 100 // roll: floor(0.02*100)+1=3
    })

    const ctx = createPipelineContext('s1', 'player1', 1, { action_arbiter: true })
    // Set high attribute so total > target without critical
    ctx.data.set('player_attributes', {
      strength: 99, constitution: 99, agility: 99, intelligence: 99,
      perception: 99, willpower: 99, charisma: 99, luck: 50,
    })
    ctx.data.set('predetermined_check', { attribute_id: 'charisma', difficulty: 'TRIVIAL' })

    const input: Action = { type: 'TALK', target: 'npc1', method: null }
    await step.execute(input, ctx)

    const check = ctx.data.get('attribute_check') as AttributeCheckResult
    expect(check.outcome).toBe('CRITICAL_FAILURE')
    expect(check.passed).toBe(false)
    expect(check.roll).toBe(3)
  })

  it('roll=50 normal pass → SUCCESS', async () => {
    let callCount = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++
      if (callCount === 1) return 0.0 // rollTarget: lowest target for TRIVIAL [40,60] → 40
      return (50 - 1) / 100 // roll=50
    })

    const ctx = createPipelineContext('s1', 'player1', 1, { action_arbiter: true })
    ctx.data.set('player_attributes', {
      strength: 50, constitution: 50, agility: 50, intelligence: 50,
      perception: 50, willpower: 50, charisma: 50, luck: 50,
    })
    ctx.data.set('predetermined_check', { attribute_id: 'charisma', difficulty: 'TRIVIAL' })

    const input: Action = { type: 'TALK', target: 'npc1', method: null }
    await step.execute(input, ctx)

    const check = ctx.data.get('attribute_check') as AttributeCheckResult
    // roll=50, attr=50, total=100 vs target=40 → SUCCESS
    expect(check.outcome).toBe('SUCCESS')
    expect(check.passed).toBe(true)
    expect(check.roll).toBe(50)
    expect(check.margin).toBe(100 - 40)
  })

  it('roll=50 normal fail → FAILURE', async () => {
    let callCount = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++
      if (callCount === 1) return 0.99 // rollTarget: highest target for LEGENDARY [160,180] → 160+floor(0.99*21)=180
      return (50 - 1) / 100 // roll=50
    })

    const ctx = createPipelineContext('s1', 'player1', 1, { action_arbiter: true })
    ctx.data.set('player_attributes', {
      strength: 50, constitution: 50, agility: 50, intelligence: 50,
      perception: 50, willpower: 50, charisma: 50, luck: 50,
    })
    ctx.data.set('predetermined_check', { attribute_id: 'charisma', difficulty: 'LEGENDARY' })

    const input: Action = { type: 'TALK', target: 'npc1', method: null }
    await step.execute(input, ctx)

    const check = ctx.data.get('attribute_check') as AttributeCheckResult
    // roll=50, attr=50, total=100 vs target=180 → FAILURE
    expect(check.outcome).toBe('FAILURE')
    expect(check.passed).toBe(false)
    expect(check.margin).toBe(100 - 180)
  })

  it('check_description includes outcome label and margin', async () => {
    let callCount = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++
      if (callCount === 1) return 0.5
      return (97 - 1) / 100 // roll=97 → CRITICAL_SUCCESS
    })

    const ctx = createPipelineContext('s1', 'player1', 1, { action_arbiter: true })
    ctx.data.set('player_attributes', {
      strength: 50, constitution: 50, agility: 50, intelligence: 50,
      perception: 50, willpower: 50, charisma: 60, luck: 50,
    })
    ctx.data.set('predetermined_check', { attribute_id: 'charisma', difficulty: 'ROUTINE' })

    const input: Action = { type: 'TALK', target: 'npc1', method: null }
    await step.execute(input, ctx)

    const desc = ctx.data.get('check_description') as string
    expect(desc).toContain('大成功!')
    expect(desc).toMatch(/\(\+\d+\)/)
  })
})
