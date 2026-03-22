import type { IPipelineStep, PipelineContext, StepResult, NarrativeOutput } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { IStateStore, ILoreStore, IEventStore } from '../../infrastructure/storage/interfaces.js'
import type {
  AtomicAction,
  ArbitrationResult,
  FeasibilityVerdict,
  RejectionStrategy,
  ReachabilityResult,
} from '../../domain/models/pipeline-io.js'
import { FeasibilityVerdictSchema, ArbitrationResultSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'

// ============================================================
// Interfaces for external dependencies
// ============================================================

export interface ILocationGraph {
  isReachable(from: string, to: string): ReachabilityResult
}

// ============================================================
// Helper: generate rejection narrative via LLM
// ============================================================

async function generateRejectionNarrative(
  action: AtomicAction,
  layer: number,
  strategy: RejectionStrategy,
  agentRunner: AgentRunner,
): Promise<NarrativeOutput> {
  const systemPrompt = [
    'You are the RejectionNarrativeGenerator for a CRPG engine.',
    'Generate a short in-character narrative explaining why the action cannot be performed.',
    'The rejection should feel natural within the game world, not mechanical.',
    'Respond with ONLY valid JSON: { "narrative_text": "string" }',
  ].join('\n')

  const userMessage = JSON.stringify({
    action,
    failure_layer: layer,
    rejection_strategy: strategy,
  })

  try {
    const response = await agentRunner.run(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { agent_type: 'RejectionNarrativeGenerator' },
    )

    let parsed: { narrative_text?: string }
    try {
      parsed = JSON.parse(response.content)
    } catch {
      parsed = {}
    }

    return {
      text: parsed.narrative_text ?? 'You find yourself unable to do that.',
      source: 'rejection',
    }
  } catch {
    return {
      text: 'You find yourself unable to do that.',
      source: 'rejection',
    }
  }
}

// ============================================================
// Step 0: ParallelQueryStep — fetch memory + world state
// ============================================================

export class ParallelQueryStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'ParallelQueryStep'
  private readonly stateStore: IStateStore

  constructor(stateStore: IStateStore) {
    this.stateStore = stateStore
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const characterId = context.player_character_id

    const [subjectiveMemory, objectiveState] = await Promise.all([
      this.stateStore.get<unknown>(`memory:subjective:${characterId}`),
      this.stateStore.get<unknown>(`world:objective:${characterId}`),
    ])

    context.data.set('subjective_memory', subjectiveMemory)
    context.data.set('objective_state', objectiveState)

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Layer 1: Information Completeness Check (LLM)
// ============================================================

export class Layer1InfoCheckStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'Layer1InfoCheckStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(FeasibilityVerdictSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const subjectiveMemory = context.data.get('subjective_memory')

    const systemPrompt = [
      'You are the NarrativeFeasibilityJudge for a CRPG engine (Layer 1: Information Check).',
      'Determine if the character subjectively possesses the information needed to perform this action.',
      'Respond with ONLY valid JSON: { "passed": boolean, "failure_reason": string|null, "rejection_strategy": "NARRATIVE_ABSORB"|"PARTIAL_EXEC"|"REINTERPRET"|null }',
    ].join('\n')

    const userMessage = JSON.stringify({
      action: input,
      check_layer: 1,
      relevant_context: JSON.stringify(subjectiveMemory),
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'NarrativeFeasibilityJudge_L1' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `Layer1 parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      if (!result.data.passed) {
        context.data.set('arbitration_failed_layer', 1)
        const narrative = await generateRejectionNarrative(
          input,
          1,
          result.data.rejection_strategy ?? 'NARRATIVE_ABSORB',
          this.agentRunner,
        )
        return { status: 'short_circuit', output: narrative }
      }

      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `Layer1 LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Layer 2: Physical / Spatial Check (pure code + LLM for text)
// ============================================================

export class Layer2PhysicalCheckStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'Layer2PhysicalCheckStep'
  private readonly locationGraph: ILocationGraph
  private readonly stateStore: IStateStore
  private readonly agentRunner: AgentRunner

  constructor(locationGraph: ILocationGraph, stateStore: IStateStore, agentRunner: AgentRunner) {
    this.locationGraph = locationGraph
    this.stateStore = stateStore
    this.agentRunner = agentRunner
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const characterId = context.player_character_id

    // Check location reachability for MOVE_TO actions
    if (input.type === 'MOVE_TO' && input.target) {
      const currentLocation = await this.stateStore.get<string>(`character:location:${characterId}`)
      if (currentLocation) {
        const reachability = this.locationGraph.isReachable(currentLocation, input.target)
        if (!reachability.reachable) {
          context.data.set('arbitration_failed_layer', 2)
          const narrative = await generateRejectionNarrative(
            input,
            2,
            'PARTIAL_EXEC',
            this.agentRunner,
          )
          return { status: 'short_circuit', output: narrative }
        }
      }
    }

    // Check NPC presence for interaction actions
    if ((input.type === 'SPEAK_TO' || input.type === 'GIVE' || input.type === 'CONFRONT') && input.target) {
      const npcPresent = await this.stateStore.get<boolean>(`npc:present:${input.target}`)
      if (npcPresent === false) {
        context.data.set('arbitration_failed_layer', 2)
        const narrative = await generateRejectionNarrative(
          input,
          2,
          'NARRATIVE_ABSORB',
          this.agentRunner,
        )
        return { status: 'short_circuit', output: narrative }
      }
    }

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Layer 3: Social / Relationship Check (LLM)
// ============================================================

export class Layer3SocialCheckStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'Layer3SocialCheckStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(FeasibilityVerdictSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const subjectiveMemory = context.data.get('subjective_memory')

    const systemPrompt = [
      'You are the NarrativeFeasibilityJudge for a CRPG engine (Layer 3: Social Check).',
      'Determine if the current relationship state and social context allow this interaction.',
      'Respond with ONLY valid JSON: { "passed": boolean, "failure_reason": string|null, "rejection_strategy": "NARRATIVE_ABSORB"|"PARTIAL_EXEC"|"REINTERPRET"|null }',
    ].join('\n')

    const userMessage = JSON.stringify({
      action: input,
      check_layer: 3,
      relevant_context: JSON.stringify(subjectiveMemory),
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'NarrativeFeasibilityJudge_L3' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `Layer3 parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      if (!result.data.passed) {
        context.data.set('arbitration_failed_layer', 3)
        const narrative = await generateRejectionNarrative(
          input,
          3,
          result.data.rejection_strategy ?? 'NARRATIVE_ABSORB',
          this.agentRunner,
        )
        return { status: 'short_circuit', output: narrative }
      }

      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `Layer3 LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Layer 4: Narrative Feasibility Check (LLM with extra query)
// ============================================================

export class Layer4NarrativeCheckStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'Layer4NarrativeCheckStep'
  private readonly agentRunner: AgentRunner
  private readonly loreStore: ILoreStore
  private readonly eventStore: IEventStore
  private readonly parser = new ResponseParser(FeasibilityVerdictSchema)

  constructor(agentRunner: AgentRunner, loreStore: ILoreStore, eventStore: IEventStore) {
    this.agentRunner = agentRunner
    this.loreStore = loreStore
    this.eventStore = eventStore
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    // Query C: fetch lore and recent events for narrative context
    const [loreEntries, recentEvents] = await Promise.all([
      input.target ? this.loreStore.findBySubject(input.target) : Promise.resolve([]),
      this.eventStore.getAllTier1(),
    ])

    const recentEventSummaries = recentEvents.slice(-10).map((e) => e.title)
    context.data.set('query_c_lore', loreEntries)
    context.data.set('query_c_events', recentEventSummaries)

    const systemPrompt = [
      'You are the NarrativeFeasibilityJudge for a CRPG engine (Layer 4: Narrative Check).',
      'Determine if narrative preconditions are met and the action would not create logical paradoxes.',
      'Respond with ONLY valid JSON: { "passed": boolean, "failure_reason": string|null, "rejection_strategy": "NARRATIVE_ABSORB"|"PARTIAL_EXEC"|"REINTERPRET"|null }',
    ].join('\n')

    const userMessage = JSON.stringify({
      action: input,
      check_layer: 4,
      lore_context: loreEntries.map((l) => ({ id: l.id, subject_ids: l.subject_ids })),
      recent_events: recentEventSummaries,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'NarrativeFeasibilityJudge_L4' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `Layer4 parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      if (!result.data.passed) {
        context.data.set('arbitration_failed_layer', 4)
        const narrative = await generateRejectionNarrative(
          input,
          4,
          result.data.rejection_strategy ?? 'REINTERPRET',
          this.agentRunner,
        )
        return { status: 'short_circuit', output: narrative }
      }

      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `Layer4 LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Layer 5: Narrative Drift Check (LLM, never short-circuits)
// ============================================================

export class Layer5DriftCheckStep implements IPipelineStep<AtomicAction, AtomicAction> {
  readonly name = 'Layer5DriftCheckStep'
  private readonly agentRunner: AgentRunner

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: AtomicAction, context: PipelineContext): Promise<StepResult<AtomicAction>> {
    const systemPrompt = [
      'You are the NarrativeFeasibilityJudge for a CRPG engine (Layer 5: Drift Check).',
      'Assess whether this action would cause significant narrative drift.',
      'This check NEVER blocks the action — it only flags drift for async handling.',
      'Respond with ONLY valid JSON: { "passed": boolean, "failure_reason": string|null, "rejection_strategy": null }',
    ].join('\n')

    const userMessage = JSON.stringify({
      action: input,
      check_layer: 5,
      session_id: context.session_id,
      turn_number: context.turn_number,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'NarrativeFeasibilityJudge_L5' },
      )

      let driftDetected = false
      try {
        const parsed = JSON.parse(response.content) as { passed?: boolean }
        driftDetected = parsed.passed === false
      } catch {
        // If parse fails, assume no drift
      }

      context.data.set('drift_flag', driftDetected)

      // Layer 5 never short-circuits
      return { status: 'continue', data: input }
    } catch {
      // On LLM failure, assume no drift and continue
      context.data.set('drift_flag', false)
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
