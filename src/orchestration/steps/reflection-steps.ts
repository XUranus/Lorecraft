import type { IPipelineStep, PipelineContext, StepResult, NarrativeOutput } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type {
  ParsedIntent,
  TraitVoiceOutput,
  DebateOutput,
  InsistenceState,
  VoiceLine,
} from '../../domain/models/pipeline-io.js'
import type { PlayerAttributes } from '../../domain/models/attributes.js'
import { ATTRIBUTE_IDS, ATTRIBUTE_META } from '../../domain/models/attributes.js'
import { VoiceDebateOutputSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { prompts } from '../../ai/prompt/prompts.js'

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
// Step 1: ActiveTraitStep — read active voices from player attributes
// ============================================================

export class ActiveTraitStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'ActiveTraitStep'

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    const attrs = context.data.get('player_attributes') as PlayerAttributes | undefined

    if (!attrs) {
      context.data.set('skip_reflection_llm', true)
      return { status: 'continue', data: input }
    }

    const activeVoices = ATTRIBUTE_IDS
      .map((id) => ({
        attr_id: id,
        value: attrs[id],
        display_name: ATTRIBUTE_META[id].display_name,
        domain: ATTRIBUTE_META[id].domain,
        voice_personality: ATTRIBUTE_META[id].voice_personality,
      }))
      .filter((v) => v.value > 10)
      .sort((a, b) => b.value - a.value)

    context.data.set('active_voices', activeVoices)

    if (activeVoices.length === 0) {
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

    if (skipLlm && !injectedContext && input.ambiguity_flags.length === 0) {
      context.data.set('reflection_silent', true)
      return { status: 'continue', data: input }
    }

    context.data.set('reflection_silent', false)
    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 4: VoiceDebateStep — single LLM call for voices + debate
// (replaces VoiceGenerationStep + DebateStep)
// ============================================================

interface ActiveVoice {
  attr_id: string
  value: number
  display_name: string
  domain: string
  voice_personality: string
}

export class VoiceDebateStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'VoiceDebateStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(VoiceDebateOutputSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    if (context.data.get('reflection_silent') === true) {
      context.data.set('trait_voices', { voices: [], debate_needed: false } satisfies TraitVoiceOutput)
      context.data.set('debate_output', null)
      return { status: 'continue', data: input }
    }

    const activeVoices = (context.data.get('active_voices') as ActiveVoice[]) ?? []
    const injectedContext = context.data.get('injected_context') as string | null
    const worldAssertionHint = context.data.get('world_assertion_hint') as string | null

    const systemPrompt = prompts.get('voice_debate')

    const userMessage = JSON.stringify({
      active_voices: activeVoices.map((v) => ({
        display_name: v.display_name,
        value: v.value,
        domain: v.domain,
        personality: v.voice_personality,
      })),
      intent_summary: input.intent,
      atomic_actions: input.atomic_actions,
      injected_context: injectedContext,
      world_assertion_hint: worldAssertionHint,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'VoiceDebateGenerator' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `VoiceDebateGenerator parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      // Set both context keys for backward compatibility with InsistenceStep
      context.data.set('trait_voices', {
        voices: result.data.voices,
        debate_needed: false,
      } satisfies TraitVoiceOutput)
      context.data.set('debate_output', {
        debate_lines: result.data.debate_lines,
      } satisfies DebateOutput)

      return { status: 'continue', data: input }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `VoiceDebateGenerator LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Step 5: InsistenceStep — state machine for force_flag
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

    const currentState = (context.data.get('insistence_state') as InsistenceState | undefined) ?? 'NORMAL'
    const hasWarnStance = voices.some((v) => v.stance === 'WARN')

    let forceFlag = false
    let forceLevel: 0 | 1 | 2 = 0
    let nextState: InsistenceState = 'NORMAL'

    if (hasWarnStance) {
      switch (currentState) {
        case 'NORMAL':
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
          forceFlag = true
          forceLevel = 1
          nextState = 'INSISTING'
          break

        case 'INSISTING':
          forceFlag = true
          forceLevel = 2
          nextState = 'NORMAL'
          break
      }
    } else {
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
// Step 6: VoiceWriteStep — write voice lines to context
// ============================================================

export class VoiceWriteStep
  implements IPipelineStep<ReflectionPipelineOutput, ReflectionPipelineOutput>
{
  readonly name = 'VoiceWriteStep'

  async execute(
    input: ReflectionPipelineOutput,
    context: PipelineContext,
  ): Promise<StepResult<ReflectionPipelineOutput>> {
    if (input.voices.length > 0) {
      context.data.set('voice_lines', input.voices.map((v) => ({
        trait_id: v.trait_id,
        line: v.line,
      })))
    }

    return { status: 'continue', data: input }
  }
}
