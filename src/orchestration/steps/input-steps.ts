import type { IPipelineStep, PipelineContext, StepResult } from '../pipeline/types.js'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type {
  ParsedIntent,
  AtomicAction,
  InputPipelineOutput,
  ToneSignals,
} from '../../domain/models/pipeline-io.js'
import { ParsedIntentSchema } from '../../domain/models/pipeline-io.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { prompts } from '../../ai/prompt/prompts.js'

// ============================================================
// Step 1: ValidationStep — basic input validation (pure code)
// ============================================================

const MAX_INPUT_LENGTH = 500

export class ValidationStep implements IPipelineStep<string, string> {
  readonly name = 'ValidationStep'

  async execute(input: string, _context: PipelineContext): Promise<StepResult<string>> {
    const trimmed = input.trim()

    if (trimmed.length === 0) {
      return {
        status: 'error',
        error: {
          code: 'EMPTY_INPUT',
          message: 'Player input must not be empty.',
          step: this.name,
          recoverable: true,
        },
      }
    }

    if (trimmed.length > MAX_INPUT_LENGTH) {
      return {
        status: 'error',
        error: {
          code: 'INPUT_TOO_LONG',
          message: `Player input exceeds maximum length of ${MAX_INPUT_LENGTH} characters.`,
          step: this.name,
          recoverable: true,
        },
      }
    }

    return { status: 'continue', data: trimmed }
  }
}

// ============================================================
// Step 2: InputParserStep — LLM parse of raw text into intent
// ============================================================

export class InputParserStep implements IPipelineStep<string, ParsedIntent> {
  readonly name = 'InputParserStep'
  private readonly agentRunner: AgentRunner
  private readonly parser = new ResponseParser(ParsedIntentSchema)

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner
  }

  async execute(input: string, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    const systemPrompt = prompts.get('input_parser')

    const recentContext = context.data.get('recent_context') as {
      recent_narrative?: string[]
      known_facts?: string[]
    } | undefined

    const userMessage = JSON.stringify({
      raw_text: input,
      session_id: context.session_id,
      player_character_id: context.player_character_id,
      turn_number: context.turn_number,
      recent_narrative: recentContext?.recent_narrative?.slice(-5) ?? [],
      known_facts: recentContext?.known_facts?.slice(-10) ?? [],
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'InputParser' },
      )

      const result = this.parser.parse(response.content)

      if (!result.success) {
        return {
          status: 'error',
          error: {
            code: 'PARSE_FAILED',
            message: `InputParser response parse failed: ${result.error.message}`,
            step: this.name,
            recoverable: false,
          },
        }
      }

      context.data.set('tone_signals', result.data.tone_signals)
      context.data.set('parsed_intent', result.data)

      return { status: 'continue', data: result.data }
    } catch (err) {
      return {
        status: 'error',
        error: {
          code: 'LLM_CALL_FAILED',
          message: `InputParser LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
          step: this.name,
          recoverable: false,
        },
      }
    }
  }
}

// ============================================================
// Step 3: WorldAssertionFilterStep — strip world assertions, store as player wish
// ============================================================

export class WorldAssertionFilterStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'WorldAssertionFilterStep'

  async execute(input: ParsedIntent, context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    const assertions = input.world_assertions ?? []

    if (assertions.length > 0) {
      // Store as low-priority wish for EventGenerator (may or may not honor)
      context.data.set('player_wish', assertions)
      // Inject a narrator hint that will be picked up by VoiceGenerationStep
      context.data.set('world_assertion_hint', assertions.join('；'))
    }

    return { status: 'continue', data: input }
  }
}

// ============================================================
// Step 4: ActionValidationStep — validate action types & sort
// ============================================================

export class ActionValidationStep implements IPipelineStep<ParsedIntent, ParsedIntent> {
  readonly name = 'ActionValidationStep'

  async execute(input: ParsedIntent, _context: PipelineContext): Promise<StepResult<ParsedIntent>> {
    if (input.atomic_actions.length === 0) {
      return {
        status: 'error',
        error: {
          code: 'NO_ACTIONS',
          message: 'ParsedIntent contains no atomic actions.',
          step: this.name,
          recoverable: false,
        },
      }
    }

    const sortedActions: AtomicAction[] = [...input.atomic_actions].sort(
      (a, b) => a.order - b.order,
    )

    return {
      status: 'continue',
      data: { ...input, atomic_actions: sortedActions },
    }
  }
}

// ============================================================
// Step 5: ToneSignalStep — write tone_signals to context
// ============================================================

export class ToneSignalStep implements IPipelineStep<ParsedIntent, InputPipelineOutput> {
  readonly name = 'ToneSignalStep'

  async execute(
    input: ParsedIntent,
    context: PipelineContext,
  ): Promise<StepResult<InputPipelineOutput>> {
    const toneSignals: ToneSignals = input.tone_signals
    context.data.set('tone_signals', toneSignals)

    const output: InputPipelineOutput = {
      original_text: (context.data.get('original_text') as string) ?? '',
      intent: input.intent,
      tone_signals: toneSignals,
      atomic_actions: input.atomic_actions,
      ambiguity_resolved: input.ambiguity_flags.length === 0,
    }

    context.data.set('input_pipeline_output', output)

    return { status: 'continue', data: output }
  }
}
