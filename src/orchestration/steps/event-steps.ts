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
import { EventGeneratorOutputSchema, SignalBOutputSchema, PacingCheckOutputSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { z } from 'zod/v4'

// ============================================================
// Intermediate type for event data flowing through the pipeline
// ============================================================

export interface EventPipelineData {
  event_id: string
  generator_output: EventGeneratorOutput
  arbitration: ArbitrationResult
}

export interface BeatPlan {
  beats: Array<{ description: string; purpose: string }>
  current_beat_index: number
  created_at_turn: number
}

// ============================================================
// Step 1: EventContextStep — assemble context for generation
// ============================================================

export class EventContextStep implements IPipelineStep<ArbitrationResult, ArbitrationResult> {
  readonly name = 'EventContextStep'
  private readonly stateStore: IStateStore
  private readonly eventStore: IEventStore

  constructor(stateStore: IStateStore, eventStore: IEventStore) {
    this.stateStore = stateStore
    this.eventStore = eventStore
  }

  async execute(
    input: ArbitrationResult,
    context: PipelineContext,
  ): Promise<StepResult<ArbitrationResult>> {
    const characterId = context.player_character_id

    const [worldState, participantStates, subjectiveMemory, worldTone, phaseIndex, phases, beatPlan] = await Promise.all([
      this.stateStore.get<string>(`world:summary:${characterId}`),
      this.stateStore.get<Array<{ npc_id: string; state_summary: string }>>(
        `participants:states:${characterId}`,
      ),
      this.stateStore.get<{
        recent_narrative: string[]
        known_facts: string[]
        known_characters: string[]
      }>(`memory:subjective:${characterId}`),
      this.stateStore.get<string>('world:tone'),
      this.stateStore.get<number>('narrative:current_phase_index'),
      this.stateStore.get<Array<{ phase_id: string; description: string; direction_summary: string }>>('narrative:phases'),
      this.stateStore.get<BeatPlan>('narrative:beat_plan'),
    ])

    context.data.set('event_world_state', worldState ?? 'No world state available.')
    context.data.set('event_participant_states', participantStates ?? [])
    context.data.set('event_recent_narrative', subjectiveMemory?.recent_narrative?.slice(-5) ?? [])
    context.data.set('event_known_facts', subjectiveMemory?.known_facts?.slice(-10) ?? [])
    context.data.set('world_tone', worldTone ?? '')

    // Narrative phase direction
    if (phases && phases.length > 0) {
      const idx = Math.min(phaseIndex ?? 0, phases.length - 1)
      context.data.set('narrative_phase', phases[idx])
      context.data.set('narrative_phase_index', idx)
      context.data.set('narrative_phase_total', phases.length)
    }

    // Beat plan (short-term scene guidance)
    if (beatPlan) {
      context.data.set('beat_plan', beatPlan)
    }

    // Recent event weights for pacing awareness
    const allEvents = await this.eventStore.getAllTier1()
    const recentWeights = allEvents.slice(-5).map((e) => e.weight)
    context.data.set('recent_event_weights', recentWeights)

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

    const systemPrompt = [
      'You are the EventGenerator agent for a CRPG engine.',
      'Generate a complete event from the given action and context.',
      toneInstruction,
      tensionInstruction,
      narrativeDirectionInstruction,
      beatInstruction,
      'IMPORTANT: The player has full freedom to roleplay ANY personality. If the action is socially reckless, rude, absurd, or provocative, DO NOT soften or redirect it — faithfully execute the action and let the WORLD react with realistic consequences (NPCs get angry, guard intervene, allies lose trust, opportunities close, etc.). The player chose this; honor their agency.',
      'CRITICAL — NARRATIVE CONTINUITY: You MUST read the recent_narrative carefully. NPCs remember what just happened. If the player attacked or insulted an NPC in a previous turn, that NPC will NOT suddenly act friendly or ignore the conflict. NPC emotional states, injuries, hostilities, and relationship changes from recent events MUST carry forward. Breaking continuity is the worst possible error.',
      'ATTRIBUTE CHECK: If an attribute_check is provided, the narrative MUST reflect its outcome. If passed, the character succeeds at the skill-dependent part. If failed, the character fails or only partially succeeds — describe the failure naturally without breaking immersion.',
      'PLAYER WISH: If player_wish is provided, it represents things the player HOPED would happen (e.g. encountering a specific NPC). You are NOT obligated to honor these wishes. Only incorporate them if they make narrative sense given the current context, location, and NPC states. If they don\'t make sense, simply ignore them — the world follows its own logic.',
      'DECISION POINT: The narrative MUST end at a moment that invites the player\'s next decision. This does NOT always mean a cliffhanger or crisis. A decision point can be: an NPC asking a casual question, choosing where to go next, deciding how to spend free time, a conversation fork, or simply a new situation that has multiple interesting responses. Match the decision point to the current tension level — not every scene needs life-or-death urgency.',
      'FORMATTING RULES for narrative_text:',
      '- Separate paragraphs with \\n\\n (double newline). NEVER write a wall of text.',
      '- Each paragraph should focus on one beat: a description, an action, or a dialogue line.',
      '- NPC dialogue MUST be wrapped in 「」 (e.g. 「这么晚了，还在收拾？」). Each dialogue line should be its own paragraph.',
      '- Sound effects or environmental sounds use 『』 (e.g. 『滋——滋滋——』). Each sound should be its own paragraph.',
      '- Player character actions and scene descriptions are plain text paragraphs.',
      '- Keep paragraphs short — 1-3 sentences max. Dense prose kills readability.',
      forceInstruction,
      pacingInstruction,
      'CHARACTER OBSERVATIONS: For every NPC who appears in this scene, include a character_observations entry describing what the PLAYER CHARACTER can observe about them RIGHT NOW — appearance, demeanor, tone of voice, body language, visible emotions. Do NOT include backstory, secrets, or information the player couldn\'t perceive. Write from the player character\'s perspective.',
      'Respond with ONLY valid JSON: { "title": string, "tags": string[], "weight": "PRIVATE"|"MINOR"|"SIGNIFICANT"|"MAJOR", "summary": string, "context": string, "narrative_text": string, "state_changes": [{ "target": string, "field": string, "change_description": string }], "character_observations": [{ "npc_name": string, "observation": string, "relationship_hint": string (optional, only if relationship change is apparent) }] }',
    ]
      .filter(Boolean)
      .join('\n')

    // Include attribute check result so narrative reflects pass/fail
    const checkDesc = context.data.get('check_description') as string | undefined
    const checkPassed = context.data.get('check_passed') as boolean | undefined

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
      attribute_check: checkDesc ? { description: checkDesc, passed: checkPassed } : null,
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

    // Update player's CharacterKnowledge from state_changes + character_observations
    await this.updateCharacterKnowledge(gen, context)

    return { status: 'continue', data: input }
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

    const systemPrompt = [
      'You are a narrative progress assessor for a CRPG engine.',
      'Given the current narrative phase and the latest event, determine:',
      '1. Whether the current phase\'s goals have been met (phase_complete: true/false)',
      '2. If a new beat plan is needed, generate 3-5 short-term scene beats that guide the next few turns toward the phase goal.',
      '',
      'A phase is complete when its key dramatic goals have been achieved — NOT just because time has passed.',
      'Beats are short-term: each describes one scene moment or interaction that moves the story forward.',
      '',
      'Respond with ONLY valid JSON:',
      '{ "phase_complete": boolean, "phase_complete_reasoning": string, "next_beats": [{ "description": string, "purpose": string }] | null }',
      'Include next_beats only when a new beat plan is needed (current plan exhausted or phase just advanced).',
    ].join('\n')

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

    const output: NarrativeOutput = {
      text: input.generator_output.narrative_text,
      source: 'event',
    }

    return { status: 'continue', data: output }
  }
}
