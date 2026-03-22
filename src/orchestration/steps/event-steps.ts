import type { IPipelineStep, PipelineContext, StepResult, NarrativeOutput } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { IStateStore, IEventStore } from '../../infrastructure/storage/interfaces.js'
import type {
  ArbitrationResult,
  EventGeneratorOutput,
} from '../../domain/models/pipeline-io.js'
import type { Event } from '../../domain/models/event.js'
import type { SignalProcessor } from '../../domain/services/signal-processor.js'
import { EventGeneratorOutputSchema, SignalBOutputSchema, PacingCheckOutputSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'

// ============================================================
// Intermediate type for event data flowing through the pipeline
// ============================================================

export interface EventPipelineData {
  event_id: string
  generator_output: EventGeneratorOutput
  arbitration: ArbitrationResult
}

// ============================================================
// Step 1: EventContextStep — assemble context for generation
// ============================================================

export class EventContextStep implements IPipelineStep<ArbitrationResult, ArbitrationResult> {
  readonly name = 'EventContextStep'
  private readonly stateStore: IStateStore

  constructor(stateStore: IStateStore) {
    this.stateStore = stateStore
  }

  async execute(
    input: ArbitrationResult,
    context: PipelineContext,
  ): Promise<StepResult<ArbitrationResult>> {
    const characterId = context.player_character_id

    const [worldState, participantStates] = await Promise.all([
      this.stateStore.get<string>(`world:summary:${characterId}`),
      this.stateStore.get<Array<{ npc_id: string; state_summary: string }>>(
        `participants:states:${characterId}`,
      ),
    ])

    context.data.set('event_world_state', worldState ?? 'No world state available.')
    context.data.set('event_participant_states', participantStates ?? [])

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 1b: PacingCheckStep — determine narrative length guidance
// ============================================================

export class PacingCheckStep implements IPipelineStep<ArbitrationResult, ArbitrationResult> {
  readonly name = 'PacingCheckStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(PacingCheckOutputSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(
    input: ArbitrationResult,
    context: PipelineContext,
  ): Promise<StepResult<ArbitrationResult>> {
    const systemPrompt = [
      'You are a narrative pacing judge for a CRPG engine.',
      'Given an action and recent context, decide if this moment calls for QUICK interaction or NARRATIVE expansion.',
      '',
      'QUICK: routine actions, simple dialogue, movement, repeated actions, checking inventory, etc. Max 100 characters.',
      'NARRATIVE: dramatic moments, first encounters, combat, discoveries, emotional scenes, plot-advancing events. No character limit.',
      '',
      'Respond with ONLY valid JSON:',
      '{ "pacing": "QUICK"|"NARRATIVE", "max_chars": number|null, "reasoning": string }',
      'For QUICK, set max_chars to 100. For NARRATIVE, set max_chars to null.',
    ].join('\n')

    const recentNarrative = context.data.get('recent_context') as {
      recent_narrative?: string[]
    } | undefined

    const userMessage = JSON.stringify({
      action: input.action,
      recent_narrative: recentNarrative?.recent_narrative?.slice(-3) ?? [],
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'PacingJudge' },
      )

      const result = this.parser.parse(response.content)
      if (result.success) {
        context.data.set('pacing', result.data)
      } else {
        // Default to narrative if parse fails
        context.data.set('pacing', { pacing: 'NARRATIVE', max_chars: null, reasoning: 'parse_fallback' })
      }
    } catch {
      // Non-critical; default to narrative
      context.data.set('pacing', { pacing: 'NARRATIVE', max_chars: null, reasoning: 'error_fallback' })
    }

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 2: EventGeneratorStep — LLM call to generate event
// ============================================================

export class EventGeneratorStep
  implements IPipelineStep<ArbitrationResult, EventGeneratorOutput>
{
  readonly name = 'EventGeneratorStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(EventGeneratorOutputSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(
    input: ArbitrationResult,
    context: PipelineContext,
  ): Promise<StepResult<EventGeneratorOutput>> {
    const worldState = context.data.get('event_world_state') as string
    const participantStates = context.data.get('event_participant_states') as
      | Array<{ npc_id: string; state_summary: string }>
      | undefined

    let forceInstruction = ''
    if (input.force_level === 1) {
      forceInstruction =
        'The player persisted after being warned. Generate mild negative consequences: NPC mild displeasure, slight opportunity cost.'
    } else if (input.force_level === 2) {
      forceInstruction =
        'The player explicitly ignored warnings and forced this action. Generate significant negative consequences: relationship damage, closed opportunities, tangible world reactions.'
    }

    // Pacing guidance from PacingCheckStep
    const pacing = context.data.get('pacing') as { pacing: string; max_chars: number | null } | undefined
    let pacingInstruction = ''
    if (pacing?.pacing === 'QUICK') {
      pacingInstruction = `PACING: This is a quick interaction. Keep narrative_text concise — no more than ${pacing.max_chars ?? 100} characters. Be brief and snappy.`
    } else {
      pacingInstruction = 'PACING: This is a narrative moment. Write vivid, immersive narrative_text at whatever length serves the story.'
    }

    const systemPrompt = [
      'You are the EventGenerator agent for a CRPG engine.',
      'Generate a complete event from the given action and context.',
      'IMPORTANT: The player has full freedom to roleplay ANY personality. If the action is socially reckless, rude, absurd, or provocative, DO NOT soften or redirect it — faithfully execute the action and let the WORLD react with realistic consequences (NPCs get angry, guards intervene, allies lose trust, opportunities close, etc.). The player chose this; honor their agency.',
      'ATTRIBUTE CHECK: If an attribute_check is provided, the narrative MUST reflect its outcome. If passed, the character succeeds at the skill-dependent part. If failed, the character fails or only partially succeeds — describe the failure naturally without breaking immersion.',
      forceInstruction,
      pacingInstruction,
      'Respond with ONLY valid JSON: { "title": string, "tags": string[], "weight": "PRIVATE"|"MINOR"|"SIGNIFICANT"|"MAJOR", "summary": string, "context": string, "narrative_text": string, "state_changes": [{ "target": string, "field": string, "change_description": string }] }',
    ]
      .filter(Boolean)
      .join('\n')

    // Include attribute check result so narrative reflects pass/fail
    const checkDesc = context.data.get('check_description') as string | undefined
    const checkPassed = context.data.get('check_passed') as boolean | undefined

    const userMessage = JSON.stringify({
      action: input.action,
      force_flag: input.force_flag,
      force_level: input.force_level,
      world_state_summary: worldState,
      participants_state: participantStates ?? [],
      attribute_check: checkDesc ? { description: checkDesc, passed: checkPassed } : null,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'EventGenerator' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `EventGenerator parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      context.data.set('generator_output', result.data)
      return { status: 'continue', data: result.data }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `EventGenerator LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Step 3: EventSchemaValidationStep — validate parsed output
// ============================================================

export class EventSchemaValidationStep
  implements IPipelineStep<EventGeneratorOutput, EventGeneratorOutput>
{
  readonly name = 'EventSchemaValidationStep'

  async execute(
    input: EventGeneratorOutput,
    _context: PipelineContext,
  ): Promise<StepResult<EventGeneratorOutput>> {
    // Re-validate against schema for safety
    const result = EventGeneratorOutputSchema.safeParse(input)

    if (!result.success) {
      return {
        status: 'error',
        error: {
          code: 'SCHEMA_VALIDATION_FAILED',
          message: `Event schema validation failed: ${result.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`,
          step: this.name,
          recoverable: false,
        },
      }
    }

    if (!input.narrative_text || input.narrative_text.trim().length === 0) {
      return {
        status: 'error',
        error: {
          code: 'EMPTY_NARRATIVE',
          message: 'Event narrative_text must not be empty.',
          step: this.name,
          recoverable: false,
        },
      }
    }

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 4: EventIdStep — generate UUID
// ============================================================

export class EventIdStep implements IPipelineStep<EventGeneratorOutput, EventPipelineData> {
  readonly name = 'EventIdStep'

  async execute(
    input: EventGeneratorOutput,
    context: PipelineContext,
  ): Promise<StepResult<EventPipelineData>> {
    const eventId = crypto.randomUUID()
    context.data.set('event_id', eventId)

    const arbitration = context.data.get('arbitration_result') as ArbitrationResult

    return {
      status: 'continue',
      data: { event_id: eventId, generator_output: input, arbitration },
    }
  }
}

// ============================================================
// Step 5: EventWriteStep — write to EventStore (all 4 tiers)
// ============================================================

export class EventWriteStep implements IPipelineStep<EventPipelineData, EventPipelineData> {
  readonly name = 'EventWriteStep'
  private readonly eventStore: IEventStore

  constructor(eventStore: IEventStore) {
    this.eventStore = eventStore
  }

  async execute(
    input: EventPipelineData,
    context: PipelineContext,
  ): Promise<StepResult<EventPipelineData>> {
    const gen = input.generator_output
    const arb = input.arbitration

    const event: Event = {
      // Tier 1
      id: input.event_id,
      title: gen.title,
      timestamp: { day: 0, hour: 0, turn: context.turn_number },
      location_id: arb.action.target ?? 'unknown',
      participant_ids: [context.player_character_id],
      tags: gen.tags as Event['tags'],
      weight: gen.weight,
      force_level: arb.force_level,
      created_at: Date.now(),
      // Tier 2
      summary: gen.summary,
      choice_signals: {},
      // Tier 3
      context: gen.context,
      related_event_ids: [],
      state_snapshot: {
        location_state: '',
        participant_states: {},
      },
      // Tier 4
      narrative_text: gen.narrative_text,
    }

    try {
      await this.eventStore.append(event)
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'EVENT_WRITE_FAILED',
          message: `Failed to write event to EventStore: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 5b: StateWritebackStep — update world state after event
// ============================================================

export class StateWritebackStep implements IPipelineStep<EventPipelineData, EventPipelineData> {
  readonly name = 'StateWritebackStep'
  private readonly stateStore: IStateStore
  private readonly eventStore: IEventStore

  constructor(stateStore: IStateStore, eventStore: IEventStore) {
    this.stateStore = stateStore
    this.eventStore = eventStore
  }

  async execute(
    input: EventPipelineData,
    context: PipelineContext,
  ): Promise<StepResult<EventPipelineData>> {
    const playerId = context.player_character_id
    const gen = input.generator_output

    // Update subjective memory: append this turn's narrative and state changes
    const prevMemory = await this.stateStore.get<{
      recent_narrative: string[]
      known_facts: string[]
      known_characters: string[]
    }>(`memory:subjective:${playerId}`)

    const recentNarrative = prevMemory?.recent_narrative ?? []
    recentNarrative.push(gen.narrative_text)
    // Keep last 20 narrative entries to avoid unbounded growth
    if (recentNarrative.length > 20) {
      recentNarrative.splice(0, recentNarrative.length - 20)
    }

    const knownFacts = prevMemory?.known_facts ?? []
    for (const sc of gen.state_changes) {
      knownFacts.push(`${sc.target}: ${sc.change_description}`)
    }
    // Keep last 50 facts
    if (knownFacts.length > 50) {
      knownFacts.splice(0, knownFacts.length - 50)
    }

    await this.stateStore.set(`memory:subjective:${playerId}`, {
      recent_narrative: recentNarrative,
      known_facts: knownFacts,
      known_characters: prevMemory?.known_characters ?? [],
    })

    // Update objective world state: current scene
    const prevObjective = await this.stateStore.get<{
      current_location: string
      scene_description: string
      present_npcs: string[]
    }>(`world:objective:${playerId}`)

    await this.stateStore.set(`world:objective:${playerId}`, {
      current_location: prevObjective?.current_location ?? '',
      scene_description: gen.narrative_text,
      present_npcs: prevObjective?.present_npcs ?? [],
    })

    // Update world summary with recent events
    const allEvents = await this.eventStore.getAllTier1()
    const recentTitles = allEvents.slice(-10).map((e) => e.title)
    const prevSummary = await this.stateStore.get<string>(`world:summary:${playerId}`) ?? ''
    // Rebuild summary: keep the world background (first line) + recent narrative
    const summaryLines = prevSummary.split('\n')
    const worldBg = summaryLines[0] ?? ''

    await this.stateStore.set(`world:summary:${playerId}`, [
      worldBg,
      `最近发生的事：${recentTitles.join('、')}`,
      `当前场景：${gen.narrative_text}`,
    ].join('\n'))

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 6: SignalBStep — conditional LLM for choice signals
// ============================================================

const SIGNAL_B_TRIGGER_TAGS = new Set([
  'RELATIONSHIP_CHANGE',
  'CONFLICT',
  'ITEM_TRANSFER',
  'WORLD_CHANGE',
])

export class SignalBStep implements IPipelineStep<EventPipelineData, EventPipelineData> {
  readonly name = 'SignalBStep'
  private readonly agentRunner: AgentRunner
  private readonly signalProcessor: SignalProcessor
  private readonly parser = new ResponseParser(SignalBOutputSchema)

  constructor(agentRunner: AgentRunner, signalProcessor: SignalProcessor) {
    this.agentRunner = agentRunner
    this.signalProcessor = signalProcessor
  }

  async execute(
    input: EventPipelineData,
    _context: PipelineContext,
  ): Promise<StepResult<EventPipelineData>> {
    const tags = input.generator_output.tags
    const shouldTag = tags.some((tag) => SIGNAL_B_TRIGGER_TAGS.has(tag))

    if (!shouldTag) {
      return { status: 'continue', data: input }
    }

    const systemPrompt = [
      'You are the SignalBTagger agent for a CRPG engine.',
      'Analyze the event and tag choice signals that reflect the player\'s character tendencies.',
      'Respond with ONLY valid JSON: { "choice_signals": { "trait_id": weight_delta } }',
    ].join('\n')

    const userMessage = JSON.stringify({
      event_summary: input.generator_output.summary,
      choice_description: input.generator_output.title,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'SignalBTagger' },
      )

      const result = this.parser.parse(response.content)

      if (result.success && Object.keys(result.data.choice_signals).length > 0) {
        await this.signalProcessor.applySignalB(result.data.choice_signals)
      }
    } catch {
      // Signal B tagging is non-critical; continue on failure
    }

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 7: EventBroadcastStep — placeholder for Phase 4 EventBus
// ============================================================

export class EventBroadcastStep implements IPipelineStep<EventPipelineData, NarrativeOutput> {
  readonly name = 'EventBroadcastStep'

  async execute(
    input: EventPipelineData,
    context: PipelineContext,
  ): Promise<StepResult<NarrativeOutput>> {
    // Phase 4: will publish event.tier1 to EventBus here
    context.data.set('event_broadcast_pending', true)
    context.data.set('final_event_id', input.event_id)

    const output: NarrativeOutput = {
      text: input.generator_output.narrative_text,
      source: 'event',
    }

    return { status: 'continue', data: output }
  }
}
