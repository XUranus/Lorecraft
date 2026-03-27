// ============================================================
// Pipeline Context: shared state across pipeline steps
// ============================================================

export interface PipelineContext {
  session_id: string
  player_character_id: string
  turn_number: number
  data: Map<string, unknown>
}

export function createPipelineContext(
  session_id: string,
  player_character_id: string,
  turn_number: number,
): PipelineContext {
  return { session_id, player_character_id, turn_number, data: new Map() }
}

// ============================================================
// Step Result: three-state return type
// ============================================================

export type StepResult<T> =
  | { status: 'continue'; data: T }
  | { status: 'short_circuit'; output: NarrativeOutput }
  | { status: 'error'; error: PipelineError }

export interface NarrativeChoice {
  text: string
  check?: {
    attribute_id: string
    attribute_display_name: string
    difficulty: string
    pass_chance: number  // 0-100
  }
}

export interface NarrativeOutput {
  text: string
  source: 'event' | 'rejection' | 'reflection'
  choices?: NarrativeChoice[]
}

export interface PipelineError {
  code: string
  message: string
  step: string
  recoverable: boolean
}

// ============================================================
// Pipeline Step Interface
// ============================================================

export interface IPipelineStep<TInput, TOutput> {
  name: string
  execute(input: TInput, context: PipelineContext): Promise<StepResult<TOutput>>
}

// ============================================================
// Pipeline Middleware
// ============================================================

export interface IPipelineMiddleware {
  before?(step_name: string, input: unknown, context: PipelineContext): void
  after?(step_name: string, result: StepResult<unknown>, context: PipelineContext, duration_ms: number): void
}
