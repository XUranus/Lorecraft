import { z } from 'zod/v4'
import type { IPipelineStep, PipelineContext, StepResult, NarrativeOutput } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { IStateStore, ILoreStore, IEventStore } from '../../infrastructure/storage/interfaces.js'
import type {
  AtomicAction,
  ArbitrationResult,
  ArbitrationReport,
} from '../../domain/models/pipeline-io.js'
import type { PlayerAttributes } from '../../domain/models/attributes.js'
import { ATTRIBUTE_IDS, ATTRIBUTE_META } from '../../domain/models/attributes.js'
import { ArbitrationReportSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'

// ============================================================
// Step 0: ParallelQueryStep — fetch memory + world state + lore
// ============================================================

export class ParallelQueryStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'ParallelQueryStep'
  private readonly stateStore: IStateStore
  private readonly loreStore: ILoreStore
  private readonly eventStore: IEventStore

  constructor(stateStore: IStateStore, loreStore: ILoreStore, eventStore: IEventStore) {
    this.stateStore = stateStore
    this.loreStore = loreStore
    this.eventStore = eventStore
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const characterId = context.player_character_id

    const [subjectiveMemory, objectiveState, loreEntries, recentEvents] = await Promise.all([
      this.stateStore.get<unknown>(`memory:subjective:${characterId}`),
      this.stateStore.get<unknown>(`world:objective:${characterId}`),
      input.target ? this.loreStore.findBySubject(input.target) : Promise.resolve([]),
      this.eventStore.getAllTier1(),
    ])

    context.data.set('subjective_memory', subjectiveMemory)
    context.data.set('objective_state', objectiveState)
    context.data.set('lore_entries', loreEntries)
    context.data.set('recent_events', recentEvents.slice(-10).map((e) => e.title))

    return { status: 'continue', data: input }
  }
}

// ============================================================
// FeasibilityCheckStep — single LLM call for all checks
// ============================================================

export class FeasibilityCheckStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'FeasibilityCheckStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(ArbitrationReportSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const subjectiveMemory = context.data.get('subjective_memory')
    const objectiveState = context.data.get('objective_state')
    const loreEntries = context.data.get('lore_entries')
    const recentEvents = context.data.get('recent_events')

    const systemPrompt = [
      'You are the FeasibilityJudge for a CRPG engine.',
      'Given an action and the current game context, determine whether the action is PHYSICALLY AND LOGICALLY POSSIBLE — nothing more.',
      '',
      'CORE PRINCIPLE: This is a free-form CRPG. Players may roleplay ANY personality — reckless, rude, absurd, villainous, comedic. The FeasibilityJudge must NEVER reject an action because it is socially inappropriate, unwise, offensive, or out of place. Those choices are the player\'s right; consequences are handled by the world simulation, not by blocking the action.',
      '',
      'Assess these dimensions:',
      '',
      '1. **Information completeness**: Does the character subjectively possess the information needed to perform this action? (The player knowing something does NOT mean the character knows it.) CRITICAL EXCEPTION: Bluffing, lying, making false accusations, guessing, and fabricating information are ALWAYS feasible — the character is deliberately making things up, which does NOT require actually possessing the information. Only reject if the action genuinely requires factual knowledge the character does not have AND the action is NOT a deliberate deception or provocation.',
      '2. **Physical/spatial feasibility**: Is the action physically possible given the character\'s current body, location, and equipment? IMPORTANT: Items or objects not explicitly mentioned in the scene should be considered present if they are reasonable for the current environment (e.g. a tavern has tables, cups, a door; a forest has trees, rocks, bushes). Only reject if the object is clearly impossible in context.',
      '3. **Logical consistency**: Would the action create a factual contradiction with established world state? (e.g. talking to a character who is dead, using an item already consumed.) Note: saying something false or unverified is NOT a logical contradiction — the character is speaking, not rewriting reality.',
      '4. **Narrative drift**: Would this action cause the story to significantly derail from the main narrative arc? (This dimension NEVER causes rejection — it only flags drift.)',
      '',
      'ONLY reject (passed=false) if dimension 1, 2, or 3 fails. Socially awkward, rude, absurd, deceptive, or "unwise" actions MUST pass — the world will react accordingly. Bluffs and lies should PASS feasibility and let the world simulation handle NPC reactions (belief, anger, confusion, etc.).',
      '',
      'If any of dimensions 1-3 fails, generate a short, in-character rejection narrative that feels natural within the game world — never expose system language to the player.',
      'If all dimensions 1-3 pass, the overall result is passed. rejection_narrative should be null.',
      '',
      'Respond with ONLY valid JSON:',
      '{ "passed": boolean, "checks": [{ "dimension": string, "passed": boolean, "reason": string|null }], "drift_flag": boolean, "rejection_narrative": string|null }',
    ].join('\n')

    const userMessage = JSON.stringify({
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
        { agent_type: 'FeasibilityJudge' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `FeasibilityJudge response parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      const report = result.data
      context.data.set('arbitration_report', report)
      context.data.set('drift_flag', report.drift_flag)

      if (!report.passed && report.rejection_narrative) {
        return {
          status: 'short_circuit',
          output: {
            text: report.rejection_narrative,
            source: 'rejection',
          } satisfies NarrativeOutput,
        }
      }

      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `FeasibilityJudge LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// AttributeCheckStep — d100 + attribute vs target (DM decides)
// ============================================================

export interface AttributeCheckResult {
  needed: boolean
  attribute_id?: string
  attribute_display_name?: string
  difficulty?: string
  target?: number
  roll?: number
  attribute_value?: number
  total?: number
  passed?: boolean
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
  if (!range) return 80 // fallback to ROUTINE midpoint
  const [min, max] = range
  return min + Math.floor(Math.random() * (max - min + 1))
}

const CheckDecisionSchema = z.object({
  needs_check: z.boolean(),
  attribute: z.string().nullable(),
  difficulty: z.string().nullable(),
  reason: z.string().nullable(),
})

export class AttributeCheckStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'AttributeCheckStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(CheckDecisionSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const attrs = context.data.get('player_attributes') as PlayerAttributes | undefined
    if (!attrs) {
      context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
      return { status: 'continue', data: input }
    }

    const subjectiveMemory = context.data.get('subjective_memory')
    const objectiveState = context.data.get('objective_state')

    const attrList = ATTRIBUTE_IDS.map((id) => `${ATTRIBUTE_META[id].display_name}(${id}): ${attrs[id]} — ${ATTRIBUTE_META[id].domain}`).join('\n')

    const systemPrompt = [
      'You are the DM (Dungeon Master) for a CRPG engine.',
      'Decide if the player\'s action requires an attribute check (skill check).',
      '',
      'WHEN TO REQUIRE A CHECK:',
      '- Actions with uncertain outcomes that depend on character ability',
      '- Physical challenges: climbing, fighting, dodging, chasing, sneaking',
      '- Mental challenges: deciphering, recalling knowledge, resisting pressure',
      '- Social challenges: persuading, deceiving, intimidating',
      '- Perception: spotting hidden details, reading body language, noticing danger',
      '',
      'WHEN NOT TO REQUIRE A CHECK:',
      '- Trivial actions anyone could do (walking, talking normally, looking around casually)',
      '- Pure narrative/roleplaying choices with no skill dependency',
      '- Actions already blocked by feasibility (physically impossible)',
      '',
      'DIFFICULTY LEVELS (choose ONE):',
      '- TRIVIAL: Almost anyone can do this, only the weakest might fail (e.g. pushing open an unlocked door, basic small talk)',
      '- ROUTINE: Needs some ability, average person succeeds more often than not (e.g. climbing a low fence, persuading a friendly NPC, spotting something partially hidden)',
      '- HARD: Genuine challenge requiring strong ability in this area (e.g. picking a good lock, deceiving a suspicious guard, hitting a moving target)',
      '- VERY_HARD: Even experts need luck (e.g. disarming a master trap, intimidating a fearless veteran, sprinting across a collapsing bridge)',
      '- LEGENDARY: Near impossible, only the absolute best have a slim chance (e.g. outrunning a horse, persuading a sworn enemy to surrender, catching an arrow mid-flight)',
      '',
      `Player attributes:\n${attrList}`,
      '',
      'Choose the MOST relevant single attribute for the check.',
      'IMPORTANT: Do NOT look at the player\'s attribute values when deciding difficulty. Difficulty is determined by the action and situation, not by how good the player is at it.',
      'Respond with ONLY valid JSON: { "needs_check": boolean, "attribute": "attribute_id"|null, "difficulty": "TRIVIAL"|"ROUTINE"|"HARD"|"VERY_HARD"|"LEGENDARY"|null, "reason": string|null }',
    ].join('\n')

    const userMessage = JSON.stringify({
      action: input,
      subjective_memory: subjectiveMemory,
      objective_world_state: objectiveState,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'CheckDM' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success || !result.data.needs_check || !result.data.attribute || !result.data.difficulty) {
        context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
        return { status: 'continue', data: input }
      }

      const decision = result.data
      const difficulty = DIFFICULTY_IDS.includes(decision.difficulty as any) ? decision.difficulty! : 'ROUTINE'
      const target = rollTarget(difficulty)
      const attrId = decision.attribute as keyof PlayerAttributes
      const meta = ATTRIBUTE_META[attrId as typeof ATTRIBUTE_IDS[number]]
      if (!meta) {
        context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
        return { status: 'continue', data: input }
      }

      // Roll d100
      const roll = Math.floor(Math.random() * 100) + 1
      const attrValue = attrs[attrId] ?? 0
      const total = roll + attrValue
      const passed = total >= target

      const checkResult: AttributeCheckResult = {
        needed: true,
        attribute_id: attrId,
        attribute_display_name: meta.display_name,
        difficulty,
        target,
        roll,
        attribute_value: attrValue,
        total,
        passed,
      }

      context.data.set('attribute_check', checkResult)
      // Store pass/fail for EventGenerator to use
      context.data.set('check_passed', passed)
      context.data.set('check_description', `${meta.display_name}检定[${difficulty}]: d100(${roll}) + ${meta.display_name}(${attrValue}) = ${total} vs 目标${target} → ${passed ? '成功' : '失败'}`)

      return { status: 'continue', data: input }
    } catch (err) {
      // On error, skip the check
      context.data.set('attribute_check', { needed: false } satisfies AttributeCheckResult)
      return { status: 'continue', data: input }
    }
  }
}

// ============================================================
// ArbitrationResultStep — assemble final result
// ============================================================

export class ArbitrationResultStep implements IPipelineStep<AtomicAction, ArbitrationResult> {
  readonly name = 'ArbitrationResultStep'

  async execute(
    input: AtomicAction,
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
