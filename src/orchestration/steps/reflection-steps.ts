import type { IPipelineStep, PipelineContext, StepResult, NarrativeOutput } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type {
  ParsedIntent,
  TraitVoiceOutput,
  DebateOutput,
  ToneSignals,
  InsistenceState,
  VoiceLine,
} from '../../domain/models/pipeline-io.js'
import type { TraitWeight } from '../../domain/models/trait.js'
import type { SignalProcessor } from '../../domain/services/signal-processor.js'
import { TraitVoiceOutputSchema, DebateOutputSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'

// ============================================================
// Reflection Pipeline intermediate type
// ============================================================

export interface ReflectionPipelineOutput {
  voices: VoiceLine[]
  debate_lines: Array<{ trait_id: string; line: string }>
  force_flag: boolean
  force_level: 0 | 1 | 2
}

// ============================================================
// Step 1: ActiveTraitStep — read active traits from SignalProcessor
// ============================================================

export class ActiveTraitStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'ActiveTraitStep'
  private readonly signalProcessor: SignalProcessor

  constructor(signalProcessor: SignalProcessor) {
    this.signalProcessor = signalProcessor
  }

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    const activeTraits = await this.signalProcessor.getActiveTraits()
    context.data.set('active_traits', activeTraits)

    const injections = (context.data.get('injection_queue') as unknown[] | undefined) ?? []
    const hasConcerningActions = input.atomic_actions.some(
      (a) => a.type === 'CONFRONT' || a.type === 'GIVE',
    )

    if (activeTraits.length === 0 && injections.length === 0 && !hasConcerningActions) {
      context.data.set('skip_reflection_llm', true)
    }

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 2: InjectionReadStep — read from injection queue
// ============================================================

export class InjectionReadStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'InjectionReadStep'

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    // Phase 4 will connect a real injection queue.
    // For now, read from context.data if present.
    const injections = (context.data.get('injection_queue') as string[] | undefined) ?? []
    context.data.set('injected_context', injections.length > 0 ? injections.join('\n') : null)

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 3: ShouldSpeakStep — decide if voices should speak
// ============================================================

export class ShouldSpeakStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'ShouldSpeakStep'

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    const skipLlm = context.data.get('skip_reflection_llm') === true
    const injectedContext = context.data.get('injected_context') as string | null

    // Silent conditions: no active traits, no injections, intent is clear
    if (skipLlm && !injectedContext && input.ambiguity_flags.length === 0) {
      context.data.set('reflection_silent', true)
      return { status: 'continue', data: input }
    }

    context.data.set('reflection_silent', false)
    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 4: VoiceGenerationStep — LLM call for trait voices
// ============================================================

export class VoiceGenerationStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'VoiceGenerationStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(TraitVoiceOutputSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    if (context.data.get('reflection_silent') === true) {
      context.data.set('trait_voices', { voices: [], debate_needed: false } satisfies TraitVoiceOutput)
      return { status: 'continue', data: input }
    }

    const activeTraits = (context.data.get('active_traits') as TraitWeight[]) ?? []
    const injectedContext = context.data.get('injected_context') as string | null

    const systemPrompt = [
      'You are the TraitVoiceGenerator agent for a CRPG engine.',
      'Generate inner voice lines for the player character based on active personality traits.',
      'Each voice represents a trait reacting to the intended action.',
      'Respond with ONLY valid JSON matching: { "voices": [{ "trait_id": string, "line": string, "stance": "WARN"|"SUPPORT"|"QUESTION"|"TAUNT" }], "debate_needed": boolean }',
    ].join('\n')

    const userMessage = JSON.stringify({
      active_traits: activeTraits.map((t) => ({
        trait_id: t.trait_id,
        weight: t.current_weight,
        type: t.trait_type,
      })),
      intent_summary: input.intent,
      atomic_actions: input.atomic_actions,
      injected_context: injectedContext,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'TraitVoiceGenerator' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `TraitVoiceGenerator parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      context.data.set('trait_voices', result.data)
      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `TraitVoiceGenerator LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Step 5: DebateStep — conditional LLM debate generation
// ============================================================

export class DebateStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'DebateStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(DebateOutputSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    const traitVoices = context.data.get('trait_voices') as TraitVoiceOutput | undefined

    if (!traitVoices || !traitVoices.debate_needed) {
      context.data.set('debate_output', null)
      return { status: 'continue', data: input }
    }

    const systemPrompt = [
      'You are the DebateGenerator agent for a CRPG engine.',
      'Generate a brief internal debate between opposing trait voices.',
      'Respond with ONLY valid JSON: { "debate_lines": [{ "trait_id": string, "line": string }] }',
    ].join('\n')

    const userMessage = JSON.stringify({
      voices: traitVoices.voices,
      intent_summary: input.intent,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'DebateGenerator' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `DebateGenerator parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      context.data.set('debate_output', result.data)
      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `DebateGenerator LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Step 6: InsistenceStep — state machine for force_flag
// ============================================================

export class InsistenceStep implements IPipelineStep<ParsedIntent, ReflectionPipelineOutput> {
  readonly name = 'InsistenceStep'

  async execute(
    input: ParsedIntent,
    context: PipelineContext,
  ): Promise<StepResult<ReflectionPipelineOutput>> {
    const traitVoices = context.data.get('trait_voices') as TraitVoiceOutput | undefined
    const debateOutput = context.data.get('debate_output') as DebateOutput | null
    const voices = traitVoices?.voices ?? []

    // Read insistence state from context (persisted across turns)
    const currentState = (context.data.get('insistence_state') as InsistenceState | undefined) ?? 'NORMAL'

    const hasWarnStance = voices.some((v) => v.stance === 'WARN')

    let forceFlag = false
    let forceLevel: 0 | 1 | 2 = 0
    let nextState: InsistenceState = 'NORMAL'

    if (hasWarnStance) {
      switch (currentState) {
        case 'NORMAL':
          // First warning — short-circuit to show warning voices
          nextState = 'WARNED'
          context.data.set('insistence_state', nextState)
          context.data.set('reflection_output', {
            voices,
            debate_lines: debateOutput?.debate_lines ?? [],
            force_flag: false,
            force_level: 0,
          } satisfies ReflectionPipelineOutput)

          return {
            status: 'short_circuit',
            output: {
              text: voices.map((v) => `[${v.trait_id}]: ${v.line}`).join('\n'),
              source: 'reflection',
            },
          }

        case 'WARNED':
          // Player persisted after warning
          forceFlag = true
          forceLevel = 1
          nextState = 'INSISTING'
          break

        case 'INSISTING':
          // Player explicitly insisted
          forceFlag = true
          forceLevel = 2
          nextState = 'NORMAL'
          break
      }
    } else {
      // No warnings — reset state
      nextState = 'NORMAL'
    }

    context.data.set('insistence_state', nextState)
    context.data.set('force_flag', forceFlag)
    context.data.set('force_level', forceLevel)

    const output: ReflectionPipelineOutput = {
      voices,
      debate_lines: debateOutput?.debate_lines ?? [],
      force_flag: forceFlag,
      force_level: forceLevel,
    }

    context.data.set('reflection_output', output)

    return { status: 'continue', data: output }
  }
}

// ============================================================
// Step 7: WeightUpdateStep — apply Signal A via SignalProcessor
// ============================================================

export class WeightUpdateStep
  implements IPipelineStep<ReflectionPipelineOutput, ReflectionPipelineOutput>
{
  readonly name = 'WeightUpdateStep'
  private readonly signalProcessor: SignalProcessor

  constructor(signalProcessor: SignalProcessor) {
    this.signalProcessor = signalProcessor
  }

  async execute(
    input: ReflectionPipelineOutput,
    context: PipelineContext,
  ): Promise<StepResult<ReflectionPipelineOutput>> {
    const toneSignals = context.data.get('tone_signals') as ToneSignals | undefined

    if (toneSignals && Object.keys(toneSignals).length > 0) {
      await this.signalProcessor.applySignalA(toneSignals)
    }

    return { status: 'continue', data: input }
  }
}
