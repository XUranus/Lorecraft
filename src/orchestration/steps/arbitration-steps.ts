import { z } from 'zod/v4'
import type { IPipelineStep, PipelineContext, StepResult, NarrativeOutput } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { IStateStore, ILoreStore, IEventStore } from '../../infrastructure/storage/interfaces.js'
import type {
  Action,
  ArbitrationResult,
} from '../../domain/models/pipeline-io.js'
import type { PlayerAttributes } from '../../domain/models/attributes.js'
import { ATTRIBUTE_IDS, ATTRIBUTE_META } from '../../domain/models/attributes.js'
import { ActionArbiterOutputSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { parseWithRepair } from '../../ai/parser/json-repair.js'
import { prompts } from '../../ai/prompt/prompts.js'

// ============================================================
// BeatPlan (shared with event-steps)
// ============================================================

export interface BeatPlan {
  beats: Array<{ description: string; purpose: string }>
  current_beat_index: number
  created_at_turn: number
}

// ============================================================
// FullContextStep — single parallel fetch for ALL pipeline data
// (replaces ParallelQueryStep + EventContextStep)
// ============================================================

export class FullContextStep implements IPipelineStep<Action, Action> {
  readonly name = 'FullContextStep'
  private readonly stateStore: IStateStore
  private readonly loreStore: ILoreStore
  private readonly eventStore: IEventStore

  constructor(stateStore: IStateStore, loreStore: ILoreStore, eventStore: IEventStore) {
    this.stateStore = stateStore
    this.loreStore = loreStore
    this.eventStore = eventStore
  }

  async execute(input: Action, context: PipelineContext): Promise<StepResult<Action>> {
    const characterId = context.player_character_id

    const [
      subjectiveMemory,
      objectiveState,
      loreEntries,
      allTier1Events,
      worldSummary,
      participantStates,
      worldTone,
      phaseIndex,
      phases,
      beatPlan,
    ] = await Promise.all([
      this.stateStore.get<unknown>(`memory:subjective:${characterId}`),
      this.stateStore.get<unknown>(`world:objective:${characterId}`),
      input.target ? this.loreStore.findBySubject(input.target) : Promise.resolve([]),
      this.eventStore.getAllTier1(),
      this.stateStore.get<string>(`world:summary:${characterId}`),
      this.stateStore.get<Array<{ npc_id: string; state_summary: string }>>(
        `participants:states:${characterId}`,
      ),
      this.stateStore.get<string>('world:tone'),
      this.stateStore.get<number>('narrative:current_phase_index'),
      this.stateStore.get<Array<{ phase_id: string; description: string; direction_summary: string }>>('narrative:phases'),
      this.stateStore.get<BeatPlan>('narrative:beat_plan'),
    ])

    // Arbitration context
    context.data.set('subjective_memory', subjectiveMemory)
    context.data.set('objective_state', objectiveState)
    context.data.set('lore_entries', loreEntries)
    context.data.set('recent_events', allTier1Events.slice(-10).map((e) => e.title))

    // Event generation context
    const mem = subjectiveMemory as { recent_narrative?: string[]; known_facts?: string[] } | undefined
    context.data.set('event_world_state', worldSummary ?? 'No world state available.')
    context.data.set('event_participant_states', participantStates ?? [])
    context.data.set('event_recent_narrative', mem?.recent_narrative?.slice(-5) ?? [])
    context.data.set('event_known_facts', mem?.known_facts?.slice(-10) ?? [])
    context.data.set('world_tone', worldTone ?? '')

    // Narrative phase direction
    if (phases && phases.length > 0) {
      const idx = Math.min(phaseIndex ?? 0, phases.length - 1)
      context.data.set('narrative_phase', phases[idx])
      context.data.set('narrative_phase_index', idx)
      context.data.set('narrative_phase_total', phases.length)
    }

    // Beat plan
    if (beatPlan) {
      context.data.set('beat_plan', beatPlan)
    }

    // Recent event weights for pacing
    const recentWeights = allTier1Events.slice(-5).map((e) => e.weight)
    context.data.set('recent_event_weights', recentWeights)

    return { status: 'continue', data: input }
  }
}

// ============================================================
// ActionArbiterStep — feasibility + skill check in one LLM call
// (replaces FeasibilityCheckStep + AttributeCheckStep)
// ============================================================

export interface CheckModifier {
  label: string
  value: number
}

export type CheckOutcome = 'CRITICAL_SUCCESS' | 'SUCCESS' | 'FAILURE' | 'CRITICAL_FAILURE'

export interface AttributeCheckResult {
  needed: boolean
  attribute_id?: string
  attribute_display_name?: string
  difficulty?: string
  base_target?: number
  modifiers?: CheckModifier[]
  target?: number
  roll?: number
  attribute_value?: number
  total?: number
  passed?: boolean
  outcome?: CheckOutcome
  margin?: number
}

const DIFFICULTY_RANGES: Record<string, [number, number]> = {
  TRIVIAL:    [40, 60],
  ROUTINE:    [70, 90],
  HARD:       [100, 120],
  VERY_HARD:  [130, 150],
  LEGENDARY:  [160, 180],
}

const DIFFICULTY_IDS = Object.keys(DIFFICULTY_RANGES) as Array<keyof typeof DIFFICULTY_RANGES>

function rollTarget(difficulty: string): number {
  const range = DIFFICULTY_RANGES[difficulty]
  if (!range) return 80
  const [min, max] = range
  return min + Math.floor(Math.random() * (max - min + 1))
}

export class ActionArbiterStep implements IPipelineStep<Action, Action> {
  readonly name = 'ActionArbiterStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(ActionArbiterOutputSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: Action, context: PipelineContext): Promise<StepResult<Action>> {
    // When action arbiter is disabled, auto-pass everything with no checks
    if (!context.options.action_arbiter) {
      context.data.set('drift_flag', false)
      context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
      return { status: 'continue', data: input }
    }

    const attrs = context.data.get('player_attributes') as PlayerAttributes | undefined

    // If a choice with a predetermined check was selected, skip the full LLM arbiter
    // but we still need feasibility — predetermined choices are assumed feasible
    const predetermined = context.data.get('predetermined_check') as { attribute_id: string; difficulty: string } | undefined
    if (predetermined) {
      // Predetermined choices skip feasibility (they were generated by the engine)
      context.data.set('drift_flag', false)
      if (attrs) {
        this.rollCheck(predetermined.attribute_id, predetermined.difficulty, [], attrs, context)
      } else {
        context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
      }
      return { status: 'continue', data: input }
    }

    // Build attribute list for the prompt
    let attrListStr = ''
    if (attrs) {
      const attrList = ATTRIBUTE_IDS.map((id) =>
        `${ATTRIBUTE_META[id].display_name}(${id}): ${attrs[id]} — ${ATTRIBUTE_META[id].domain}`
      ).join('\n')
      attrListStr = `Player attributes:\n${attrList}`
    }

    const subjectiveMemory = context.data.get('subjective_memory')
    const objectiveState = context.data.get('objective_state')
    const loreEntries = context.data.get('lore_entries')
    const recentEvents = context.data.get('recent_events')

    const systemPrompt = prompts.fill('action_arbiter', {
      attribute_list: attrListStr,
    })

    const originalText = context.data.get('original_text') as string | undefined

    const userMessage = JSON.stringify({
      player_input: originalText ?? null,
      action: input,
      subjective_memory: subjectiveMemory,
      objective_world_state: objectiveState,
      lore_context: loreEntries,
      recent_events: recentEvents,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'ActionArbiter' },
      )

      const result = await parseWithRepair(
        this.parser,
        this.agentRunner,
        response.content,
        '{ "passed": boolean, "checks": [{ "dimension": string, "passed": boolean, "reason": string|null }], "drift_flag": boolean, "rejection_narrative": string|null, "needs_check": boolean, "attribute": string|null, "difficulty": string|null, "modifiers": [{ "label": string, "value": number }]|null, "check_reason": string|null }',
      )

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `ActionArbiter response parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      const data = result.data
      context.data.set('drift_flag', data.drift_flag)

      // Feasibility check
      if (!data.passed && data.rejection_narrative) {
        context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
        return {
          status: 'short_circuit',
          output: {
            text: data.rejection_narrative,
            source: 'rejection',
          } satisfies NarrativeOutput,
        }
      }

      // Skill check
      if (data.needs_check && data.attribute && data.difficulty && attrs) {
        const modifiers: CheckModifier[] = (data.modifiers ?? []).map((m) => ({
          label: m.label,
          value: Math.max(-30, Math.min(30, m.value)),
        }))
        this.rollCheck(data.attribute, data.difficulty, modifiers, attrs, context)
      } else {
        context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
      }

      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `ActionArbiter LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }

  private rollCheck(
    attributeId: string,
    difficultyStr: string,
    modifiers: CheckModifier[],
    attrs: PlayerAttributes,
    context: PipelineContext,
  ): void {
    const difficulty = DIFFICULTY_IDS.includes(difficultyStr as any) ? difficultyStr : 'ROUTINE'
    const baseTarget = rollTarget(difficulty)
    const modifierSum = modifiers.reduce((sum, m) => sum + m.value, 0)
    const target = Math.max(10, baseTarget + modifierSum)

    const attrId = attributeId as keyof PlayerAttributes
    const meta = ATTRIBUTE_META[attrId as typeof ATTRIBUTE_IDS[number]]
    if (!meta) {
      context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
      return
    }

    const roll = Math.floor(Math.random() * 100) + 1
    const attrValue = attrs[attrId] ?? 0
    const total = roll + attrValue
    const margin = total - target

    // Critical outcomes override numeric comparison
    let outcome: CheckOutcome
    let passed: boolean
    if (roll >= 95) {
      outcome = 'CRITICAL_SUCCESS'
      passed = true
    } else if (roll <= 5) {
      outcome = 'CRITICAL_FAILURE'
      passed = false
    } else if (total >= target) {
      outcome = 'SUCCESS'
      passed = true
    } else {
      outcome = 'FAILURE'
      passed = false
    }

    const outcomeLabel: Record<CheckOutcome, string> = {
      CRITICAL_SUCCESS: '大成功!',
      SUCCESS: '成功',
      FAILURE: '失败',
      CRITICAL_FAILURE: '大失败!',
    }

    const checkResult: AttributeCheckResult = {
      needed: true,
      attribute_id: attrId,
      attribute_display_name: meta.display_name,
      difficulty,
      base_target: baseTarget,
      modifiers,
      target,
      roll,
      attribute_value: attrValue,
      total,
      passed,
      outcome,
      margin,
    }

    context.data.set('attribute_check', checkResult)
    context.data.set('check_passed', passed)
    const marginStr = margin >= 0 ? `+${margin}` : `${margin}`
    context.data.set('check_description',
      `${meta.display_name}检定[${difficulty}]: d100(${roll}) + ${meta.display_name}(${attrValue}) = ${total} vs 目标${target} → ${outcomeLabel[outcome]} (${marginStr})`)
  }
}

// ============================================================
// ArbitrationResultStep — assemble final result
// ============================================================

export class ArbitrationResultStep implements IPipelineStep<Action, ArbitrationResult> {
  readonly name = 'ArbitrationResultStep'

  async execute(
    input: Action,
    context: PipelineContext,
  ): Promise<StepResult<ArbitrationResult>> {
    const forceFlag = (context.data.get('force_flag') as boolean | undefined) ?? false
    const forceLevel = (context.data.get('force_level') as 0 | 1 | 2 | undefined) ?? 0
    const driftFlag = (context.data.get('drift_flag') as boolean | undefined) ?? false

    const result: ArbitrationResult = {
      passed: true,
      action: input,
      force_flag: forceFlag,
      force_level: forceLevel,
      drift_flag: driftFlag,
      rejection_text: null,
    }

    context.data.set('arbitration_result', result)

    return { status: 'continue', data: result }
  }
}
