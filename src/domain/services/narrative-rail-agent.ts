import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import type { IEventStore, IStateStore } from '../../infrastructure/storage/interfaces.js'
import type { NarrativePhase } from '../../domain/models/genesis.js'
import type { ReflectionInjection, NPCInjection } from '../../domain/models/injection.js'
import { z } from 'zod/v4'

// ============================================================
// Drift Assessment Schema
// ============================================================

const DriftAssessmentSchema = z.object({
  drift_level: z.enum(['NONE', 'MILD', 'MODERATE', 'SEVERE']),
  needs_intervention: z.boolean(),
  suggested_level: z.number().int().min(0).max(3),
  reasoning: z.string(),
})

export type DriftAssessment = z.infer<typeof DriftAssessmentSchema>

// LLM response schemas
const ReflectionContentSchema = z.object({
  voice_id: z.string(),
  content: z.string(),
})

const NPCTopicSchema = z.object({
  context: z.string(),
  condition: z.string(),
})

const NPCActionSchema = z.object({
  action_description: z.string(),
})

// ============================================================
// Intervention Result
// ============================================================

export type InterventionResult =
  | { type: 'reflection'; injection: ReflectionInjection }
  | { type: 'npc'; injection: NPCInjection }
  | { type: 'npc_action'; npc_id: string; action_description: string }
  | null

// ============================================================
// NarrativeRailAgent
// ============================================================

export class NarrativeRailAgent {
  private readonly agentRunner: AgentRunner
  private readonly eventStore: IEventStore
  private readonly stateStore: IStateStore
  private readonly driftParser = new ResponseParser(DriftAssessmentSchema)
  private readonly reflectionParser = new ResponseParser(ReflectionContentSchema)
  private readonly npcTopicParser = new ResponseParser(NPCTopicSchema)
  private readonly npcActionParser = new ResponseParser(NPCActionSchema)

  private consecutiveIneffectiveInterventions = 0
  private lastInterventionTurn = -1
  private lastInterventionLevel = 0

  constructor(agentRunner: AgentRunner, eventStore: IEventStore, stateStore: IStateStore) {
    this.agentRunner = agentRunner
    this.eventStore = eventStore
    this.stateStore = stateStore
  }

  async assessDrift(currentPhase: NarrativePhase, currentTurn: number): Promise<DriftAssessment> {
    const allEvents = await this.eventStore.getAllTier1()
    const recentEvents = allEvents.slice(-10)
    const driftFlag = await this.stateStore.get<boolean>('pipeline:drift_flag')
    const lastIntervention = await this.stateStore.get<{
      turn: number
      level: number
      effective: boolean | null
    }>('narrative_rail:last_intervention')

    const systemPrompt = [
      'You are the DriftAssessor for a CRPG narrative rail system.',
      'Assess how far the current event flow has drifted from the intended narrative phase.',
      'Respond with ONLY valid JSON: { "drift_level": "NONE"|"MILD"|"MODERATE"|"SEVERE", "needs_intervention": boolean, "suggested_level": 0-3, "reasoning": string }',
    ].join('\n')

    const userMessage = JSON.stringify({
      current_phase: currentPhase,
      recent_events: recentEvents.map((e) => ({ title: e.title, tags: e.tags, weight: e.weight })),
      drift_flag: driftFlag ?? false,
      last_intervention: lastIntervention,
      current_turn: currentTurn,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'DriftAssessor' },
      )

      const result = this.driftParser.parse(response.content)
      if (result.success) {
        return result.data
      }
    } catch {
      // Fall through to default
    }

    return {
      drift_level: 'NONE',
      needs_intervention: false,
      suggested_level: 0,
      reasoning: 'Assessment unavailable',
    }
  }

  async generateIntervention(
    assessment: DriftAssessment,
    currentPhase: NarrativePhase,
    currentTurn: number,
    _playerCharacterId: string,
  ): Promise<InterventionResult> {
    if (!assessment.needs_intervention) {
      return null
    }

    // Determine intervention level based on escalation
    let level: number
    if (this.consecutiveIneffectiveInterventions >= 4) {
      level = 3
    } else if (this.consecutiveIneffectiveInterventions >= 2) {
      level = 2
    } else {
      level = Math.max(1, assessment.suggested_level)
    }

    // Try the determined level, fall back as needed
    if (level >= 3) {
      const result = await this.tryLevel3(currentPhase, currentTurn)
      if (result) {
        this.updateTrackingState(currentTurn, 3)
        return result
      }
      level = 2 // Fall back
    }

    if (level >= 2) {
      const result = await this.tryLevel2(currentPhase, currentTurn)
      if (result) {
        this.updateTrackingState(currentTurn, 2)
        return result
      }
      // Fall back to level 1
    }

    const result = await this.tryLevel1(currentPhase, currentTurn)
    if (result) {
      this.updateTrackingState(currentTurn, 1)
    }
    return result
  }

  recordInterventionEffect(effective: boolean): void {
    if (effective) {
      this.consecutiveIneffectiveInterventions = 0
    } else {
      this.consecutiveIneffectiveInterventions++
    }
  }

  // Getters for testing
  getConsecutiveIneffective(): number {
    return this.consecutiveIneffectiveInterventions
  }

  getLastInterventionLevel(): number {
    return this.lastInterventionLevel
  }

  // ---- Private helpers ----

  private async tryLevel1(
    currentPhase: NarrativePhase,
    currentTurn: number,
  ): Promise<InterventionResult> {
    const systemPrompt = [
      'Generate an inner voice reflection that subtly guides the player back toward the narrative.',
      'This should feel like an internal thought, not a direct instruction.',
      'Respond with ONLY valid JSON: { "voice_id": string, "content": string }',
    ].join('\n')

    const userMessage = JSON.stringify({
      phase: currentPhase,
      turn: currentTurn,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'InterventionContentGenerator_L1' },
      )

      const result = this.reflectionParser.parse(response.content)
      if (result.success) {
        const injection: ReflectionInjection = {
          id: crypto.randomUUID(),
          voice_id: result.data.voice_id,
          content: result.data.content,
          priority: 'LOW',
          expiry_turns: 5,
          created_at_turn: currentTurn,
        }
        return { type: 'reflection', injection }
      }
    } catch {
      // Unable to generate
    }
    return null
  }

  private async tryLevel2(
    currentPhase: NarrativePhase,
    currentTurn: number,
  ): Promise<InterventionResult> {
    const npcId = await this.findPhaseNPC(currentPhase)
    if (!npcId) return null

    const systemPrompt = [
      'Generate a topic for an NPC to steer conversation toward the narrative.',
      'The topic should feel natural, not forced.',
      'Respond with ONLY valid JSON: { "context": string, "condition": string }',
    ].join('\n')

    const userMessage = JSON.stringify({
      phase: currentPhase,
      npc_id: npcId,
      turn: currentTurn,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'InterventionContentGenerator_L2' },
      )

      const result = this.npcTopicParser.parse(response.content)
      if (result.success) {
        const injection: NPCInjection = {
          id: crypto.randomUUID(),
          npc_id: npcId,
          context: result.data.context,
          condition: result.data.condition,
          expiry_turns: 8,
          created_at_turn: currentTurn,
        }
        return { type: 'npc', injection }
      }
    } catch {
      // Unable to generate
    }
    return null
  }

  private async tryLevel3(
    currentPhase: NarrativePhase,
    currentTurn: number,
  ): Promise<InterventionResult> {
    const npcId = await this.findPhaseNPC(currentPhase)
    if (!npcId) return null

    const systemPrompt = [
      'Generate an NPC autonomous action to bring the player back to the narrative.',
      'The NPC should actively seek the player out.',
      'Respond with ONLY valid JSON: { "action_description": string }',
    ].join('\n')

    const userMessage = JSON.stringify({
      phase: currentPhase,
      npc_id: npcId,
      turn: currentTurn,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'InterventionContentGenerator_L3' },
      )

      const result = this.npcActionParser.parse(response.content)
      if (result.success) {
        return {
          type: 'npc_action',
          npc_id: npcId,
          action_description: result.data.action_description,
        }
      }
    } catch {
      // Unable to generate
    }
    return null
  }

  private async findPhaseNPC(phase: NarrativePhase): Promise<string | null> {
    const phaseNpcs = await this.stateStore.get<string[]>(
      `narrative_rail:phase_npcs:${phase.phase_id}`,
    )
    if (!phaseNpcs || phaseNpcs.length === 0) return null
    return phaseNpcs[0]
  }

  private updateTrackingState(turn: number, level: number): void {
    this.lastInterventionTurn = turn
    this.lastInterventionLevel = level
    // Persist asynchronously (fire-and-forget)
    this.stateStore
      .set('narrative_rail:last_intervention', {
        turn,
        level,
        effective: null, // Will be updated by recordInterventionEffect
      })
      .catch(() => {})
  }
}
