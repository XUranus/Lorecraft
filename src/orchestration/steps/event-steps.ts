import type { IPipelineStep, PipelineContext, StepResult, NarrativeOutput } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { IStateStore, IEventStore } from '../../infrastructure/storage/interfaces.js'
import type {
  ArbitrationResult,
  EventGeneratorOutput,
} from '../../domain/models/pipeline-io.js'
import type { CharacterKnowledge } from '../../domain/models/character.js'
import type { Event } from '../../domain/models/event.js'
import type { SignalProcessor } from '../../domain/services/signal-processor.js'
import { EventGeneratorOutputSchema, SignalBOutputSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { prompts } from '../../ai/prompt/prompts.js'
import { z } from 'zod/v4'
import { uuid } from '../../utils/uuid.js'
import type { BeatPlan } from './arbitration-steps.js'

// ============================================================
// Intermediate type for event data flowing through the pipeline
// ============================================================

export interface EventPipelineData {
  event_id: string
  generator_output: EventGeneratorOutput
  arbitration: ArbitrationResult
}

// ============================================================
// PacingStep — rule-based pacing decision (no LLM)
// (replaces PacingCheckStep)
// ============================================================

const QUICK_ACTION_TYPES = new Set([
  'MOVE_TO', 'MOVE', 'EXAMINE', 'OBSERVE', 'LOOK', 'CHECK', 'INVENTORY', 'WAIT',
])

export class PacingStep implements IPipelineStep<ArbitrationResult, ArbitrationResult> {
  readonly name = 'PacingStep'

  async execute(
    input: ArbitrationResult,
    context: PipelineContext,
  ): Promise<StepResult<ArbitrationResult>> {
    const actionType = input.action.type.toUpperCase()
    const recentWeights = context.data.get('recent_event_weights') as string[] | undefined

    // Rule 1: Routine actions are quick
    if (QUICK_ACTION_TYPES.has(actionType)) {
      context.data.set('pacing', { pacing: 'QUICK', max_chars: 100, reasoning: 'routine_action' })
      return { status: 'continue', data: input }
    }

    // Rule 2: After sustained high tension, force a breather (still narrative but flagged)
    if (recentWeights && recentWeights.length >= 3) {
      const highCount = recentWeights.filter((w) => w === 'MAJOR' || w === 'SIGNIFICANT').length
      if (highCount >= 3) {
        context.data.set('pacing', { pacing: 'NARRATIVE', max_chars: null, reasoning: 'tension_breather' })
        return { status: 'continue', data: input }
      }
    }

    // Default: narrative
    context.data.set('pacing', { pacing: 'NARRATIVE', max_chars: null, reasoning: 'default' })
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

    // Tone from world setting
    const worldTone = context.data.get('world_tone') as string | undefined
    const toneInstruction = worldTone
      ? `TONE (MANDATORY): The world's tone is "${worldTone}". Your narrative MUST match this tone. If the tone is comedic, write comedy even during tense moments. If the tone is melancholic, maintain that even during victories. The tone is the soul of this world — never betray it. A horror scene in a comedy world should still have comedic undertones. A romance world should weave character chemistry into every scene.`
      : ''

    // Pacing tension control from recent event weights
    const recentWeights = context.data.get('recent_event_weights') as string[] | undefined
    let tensionInstruction = ''
    if (recentWeights && recentWeights.length >= 3) {
      const highTensionCount = recentWeights.filter((w) => w === 'MAJOR' || w === 'SIGNIFICANT').length
      if (highTensionCount >= 3) {
        tensionInstruction = 'TENSION CONTROL (CRITICAL): The last several events have ALL been high-tension (SIGNIFICANT/MAJOR). The story NEEDS a breather. This event MUST be lower intensity — use PRIVATE or MINOR weight. Include character interactions, quiet moments, dialogue, humor, or reflection. Constant high tension is exhausting and bad storytelling. Let the reader breathe before the next climax.'
      } else if (highTensionCount === 0) {
        tensionInstruction = 'TENSION NOTE: Recent events have been calm. If the player\'s action warrants it, you may escalate tension.'
      }
    }

    // Narrative direction from current phase + beat plan
    const narrativePhase = context.data.get('narrative_phase') as { phase_id: string; description: string; direction_summary: string } | undefined
    const phaseIndex = context.data.get('narrative_phase_index') as number | undefined
    const phaseTotal = context.data.get('narrative_phase_total') as number | undefined
    const beatPlan = context.data.get('beat_plan') as BeatPlan | undefined

    let narrativeDirectionInstruction = ''
    if (narrativePhase) {
      narrativeDirectionInstruction = `NARRATIVE DIRECTION (IMPORTANT): The story is currently in phase ${(phaseIndex ?? 0) + 1}/${phaseTotal ?? '?'}: "${narrativePhase.description}". The intended direction is: "${narrativePhase.direction_summary}". While respecting player agency, gently weave narrative elements that align with this direction. Introduce relevant characters, clues, or situations that make the player WANT to engage with the main story. Do NOT force it — but do NOT let the story stagnate in aimless scenes either. If the player's action naturally connects to the narrative direction, amplify that connection.`
    }

    let beatInstruction = ''
    if (beatPlan && beatPlan.current_beat_index < beatPlan.beats.length) {
      const currentBeat = beatPlan.beats[beatPlan.current_beat_index]
      beatInstruction = `CURRENT SCENE BEAT: "${currentBeat.description}" (purpose: ${currentBeat.purpose}). Try to incorporate this beat naturally into the scene. If the player's action makes this beat impossible, adapt — but still aim to advance the story rather than spinning in place.`
    }

    const systemPrompt = prompts.fill('event_generator', {
      tone_instruction: toneInstruction,
      tension_instruction: tensionInstruction,
      narrative_direction_instruction: narrativeDirectionInstruction,
      beat_instruction: beatInstruction,
      force_instruction: forceInstruction,
      pacing_instruction: pacingInstruction,
    })

    // Include attribute check result so narrative reflects pass/fail
    const checkDesc = context.data.get('check_description') as string | undefined
    const checkPassed = context.data.get('check_passed') as boolean | undefined
    const checkResult = context.data.get('attribute_check') as import('./arbitration-steps.js').AttributeCheckResult | undefined
    const checkOutcome = checkResult?.outcome
    const checkMargin = checkResult?.margin

    // Luck value for critical outcome narrative modulation
    const playerAttrs = context.data.get('player_attributes') as import('../../domain/models/attributes.js').PlayerAttributes | undefined
    const luckValue = playerAttrs?.luck

    // Recent narrative history for continuity
    const recentNarrative = context.data.get('event_recent_narrative') as string[] | undefined
    const knownFacts = context.data.get('event_known_facts') as string[] | undefined

    // Player wish from world assertions — low-priority, may or may not happen
    const playerWish = context.data.get('player_wish') as string[] | undefined

    const userMessage = JSON.stringify({
      action: input.action,
      force_flag: input.force_flag,
      force_level: input.force_level,
      world_tone: worldTone ?? null,
      recent_event_weights: recentWeights ?? [],
      world_state_summary: worldState,
      participants_state: participantStates ?? [],
      recent_narrative: recentNarrative ?? [],
      known_facts: knownFacts ?? [],
      attribute_check: checkDesc ? { description: checkDesc, passed: checkPassed, outcome: checkOutcome, margin: checkMargin, luck_value: luckValue ?? null } : null,
      player_wish: playerWish ?? null,
      narrative_direction: narrativePhase ? {
        phase: narrativePhase.description,
        direction: narrativePhase.direction_summary,
        current_beat: beatPlan && beatPlan.current_beat_index < beatPlan.beats.length
          ? beatPlan.beats[beatPlan.current_beat_index].description
          : null,
      } : null,
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
    const eventId = uuid()
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

    // Apply player location changes from state_changes
    await this.applyLocationChanges(gen, context)

    // Update player's CharacterKnowledge from state_changes + character_observations
    await this.updateCharacterKnowledge(gen, context)

    return { status: 'continue', data: input }
  }
  private async applyLocationChanges(
    gen: EventGeneratorOutput,
    context: PipelineContext,
  ): Promise<void> {
    const playerId = context.player_character_id

    for (const sc of gen.state_changes) {
      const fieldLower = sc.field.toLowerCase()
      const isLocationField = fieldLower === 'location' || fieldLower.includes('位置')

      // Match player location changes: target can be the player id, "player", "Player", etc.
      const targetLower = sc.target.toLowerCase()
      const isPlayerTarget = targetLower === playerId.toLowerCase()
        || targetLower === 'player'
        || targetLower.startsWith('player')
        || sc.target === playerId

      if (isLocationField && isPlayerTarget) {
        // Write to the key that game-loop.ts reads
        await this.stateStore.set(`character:location:${playerId}`, sc.change_description)

        // Also update the objective world state location
        const prevObjective = await this.stateStore.get<{
          current_location: string
          scene_description: string
          present_npcs: string[]
        }>(`world:objective:${playerId}`)

        if (prevObjective) {
          prevObjective.current_location = sc.change_description
          await this.stateStore.set(`world:objective:${playerId}`, prevObjective)
        }
      }
    }
  }

  private async updateCharacterKnowledge(
    gen: EventGeneratorOutput,
    context: PipelineContext,
  ): Promise<void> {
    // Load NPC name→id map for target resolution
    const nameMap = await this.stateStore.get<Record<string, string>>('player:npc_name_map')
    if (!nameMap) return

    const idSet = new Set(Object.values(nameMap))

    // Helper: resolve a name or id to NPC id
    const resolveNpcId = (target: string): string | null => {
      if (idSet.has(target)) return target
      if (nameMap[target]) return nameMap[target]
      return null
    }

    // Helper: resolve NPC id to name
    const resolveNpcName = (npcId: string): string => {
      return Object.entries(nameMap).find(([, id]) => id === npcId)?.[0] ?? npcId
    }

    // Helper: get or create knowledge entry
    const getOrCreate = async (npcId: string): Promise<CharacterKnowledge> => {
      const existing = await this.stateStore.get<CharacterKnowledge>(`player:knowledge:${npcId}`)
      if (existing) return existing
      return {
        npc_id: npcId,
        name: resolveNpcName(npcId),
        first_impression: '',
        known_facts: [],
        relationship_to_player: '',
        last_seen_location: '',
        last_seen_emotion: '',
        last_interaction_turn: context.turn_number,
      }
    }

    const touched = new Set<string>()

    // 1. Process character_observations (player-perspective impressions)
    if (gen.character_observations && gen.character_observations.length > 0) {
      for (const obs of gen.character_observations) {
        const npcId = resolveNpcId(obs.npc_name)
        if (!npcId) continue

        const knowledge = await getOrCreate(npcId)
        touched.add(npcId)

        // First observation becomes first_impression if empty
        if (!knowledge.first_impression) {
          knowledge.first_impression = obs.observation
        } else {
          // Subsequent observations go to known_facts
          const last = knowledge.known_facts[knowledge.known_facts.length - 1]
          if (last !== obs.observation) {
            knowledge.known_facts.push(obs.observation)
          }
        }

        if (obs.relationship_hint) {
          knowledge.relationship_to_player = obs.relationship_hint
        }

        knowledge.last_interaction_turn = context.turn_number
        await this.stateStore.set(`player:knowledge:${npcId}`, knowledge)
      }
    }

    // 2. Process state_changes for additional fact accumulation
    if (gen.state_changes && gen.state_changes.length > 0) {
      for (const sc of gen.state_changes) {
        const npcId = resolveNpcId(sc.target)
        if (!npcId) continue

        const knowledge = await getOrCreate(npcId)
        touched.add(npcId)

        // Append as known fact (deduplicate)
        const last = knowledge.known_facts[knowledge.known_facts.length - 1]
        if (last !== sc.change_description) {
          knowledge.known_facts.push(sc.change_description)
        }

        const fieldLower = sc.field.toLowerCase()
        if (fieldLower.includes('emotion') || fieldLower.includes('情绪')) {
          knowledge.last_seen_emotion = sc.change_description
        }
        if (fieldLower.includes('location') || fieldLower.includes('位置')) {
          knowledge.last_seen_location = sc.change_description
        }
        if (fieldLower.includes('relationship') || fieldLower.includes('关系') || fieldLower.includes('态度')) {
          knowledge.relationship_to_player = sc.change_description
        }

        knowledge.last_interaction_turn = context.turn_number
        await this.stateStore.set(`player:knowledge:${npcId}`, knowledge)
      }
    }

    // Cap known_facts for all touched entries
    for (const npcId of touched) {
      const knowledge = await this.stateStore.get<CharacterKnowledge>(`player:knowledge:${npcId}`)
      if (knowledge && knowledge.known_facts.length > 50) {
        knowledge.known_facts.splice(0, knowledge.known_facts.length - 50)
        await this.stateStore.set(`player:knowledge:${npcId}`, knowledge)
      }
    }
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

    const systemPrompt = prompts.get('signal_b_tagger')

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
// Step 6b: NarrativeProgressStep — advance phase & beat plan
// ============================================================

const NarrativeProgressSchema = z.object({
  phase_complete: z.boolean(),
  phase_complete_reasoning: z.string(),
  next_beats: z.array(z.object({
    description: z.string(),
    purpose: z.string(),
  })).optional(),
})

export class NarrativeProgressStep implements IPipelineStep<EventPipelineData, EventPipelineData> {
  readonly name = 'NarrativeProgressStep'
  private readonly agentRunner: AgentRunner
  private readonly stateStore: IStateStore
  private readonly parser = new ResponseParser(NarrativeProgressSchema)

  constructor(agentRunner: AgentRunner, stateStore: IStateStore) {
    this.agentRunner = agentRunner
    this.stateStore = stateStore
  }

  async execute(
    input: EventPipelineData,
    context: PipelineContext,
  ): Promise<StepResult<EventPipelineData>> {
    if (!context.options.narrative_progress) {
      return { status: 'continue', data: input }
    }

    const phases = await this.stateStore.get<Array<{ phase_id: string; description: string; direction_summary: string }>>('narrative:phases')
    if (!phases || phases.length === 0) {
      return { status: 'continue', data: input }
    }

    const phaseIndex = (await this.stateStore.get<number>('narrative:current_phase_index')) ?? 0
    const currentPhase = phases[Math.min(phaseIndex, phases.length - 1)]
    const beatPlan = await this.stateStore.get<BeatPlan>('narrative:beat_plan')

    // Advance beat index each turn
    if (beatPlan && beatPlan.current_beat_index < beatPlan.beats.length) {
      beatPlan.current_beat_index++
      await this.stateStore.set('narrative:beat_plan', beatPlan)
    }

    // Check if we need a new beat plan (exhausted or doesn't exist)
    const needsNewBeatPlan = !beatPlan
      || beatPlan.current_beat_index >= beatPlan.beats.length
      || (context.turn_number - beatPlan.created_at_turn >= 5)

    // Ask LLM: is the current phase complete? Generate new beats if needed.
    const gen = input.generator_output

    const systemPrompt = prompts.get('narrative_progress_assessor')

    const userMessage = JSON.stringify({
      current_phase: currentPhase,
      phase_index: phaseIndex,
      total_phases: phases.length,
      latest_event: { title: gen.title, summary: gen.summary, tags: gen.tags, weight: gen.weight },
      current_beat_plan: beatPlan,
      needs_new_beat_plan: needsNewBeatPlan,
      turn: context.turn_number,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'NarrativeProgressAssessor' },
      )

      const result = this.parser.parse(response.content)
      if (result.success) {
        // Advance phase if complete and not at the last phase
        if (result.data.phase_complete && phaseIndex < phases.length - 1) {
          await this.stateStore.set('narrative:current_phase_index', phaseIndex + 1)
        }

        // Update beat plan if new beats were generated
        if (result.data.next_beats && result.data.next_beats.length > 0) {
          const newPlan: BeatPlan = {
            beats: result.data.next_beats,
            current_beat_index: 0,
            created_at_turn: context.turn_number,
          }
          await this.stateStore.set('narrative:beat_plan', newPlan)
        }
      }
    } catch {
      // Non-critical — narrative progresses regardless
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

    // Pass choices through for the game loop to enrich with pass_chance
    const rawChoices = input.generator_output.choices
    if (rawChoices && rawChoices.length > 0) {
      context.data.set('raw_choices', rawChoices)
    }

    const output: NarrativeOutput = {
      text: input.generator_output.narrative_text,
      source: 'event',
    }

    return { status: 'continue', data: output }
  }
}
