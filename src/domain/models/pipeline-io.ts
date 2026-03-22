import { z } from 'zod/v4'

// ============================================================
// Atomic Action Types
// ============================================================

export const AtomicActionType = z.enum([
  'MOVE_TO',
  'SPEAK_TO',
  'EXAMINE',
  'GIVE',
  'CONFRONT',
  'WAIT',
  'THINK',
])
export type AtomicActionType = z.infer<typeof AtomicActionType>

export const AtomicActionSchema = z.object({
  type: AtomicActionType,
  target: z.string().nullable(),
  method: z.string().nullable(),
  order: z.number().int().nonnegative(),
})

export type AtomicAction = z.infer<typeof AtomicActionSchema>

// ============================================================
// Tone Signals (Signal A input)
// ============================================================

export const ToneSignalsSchema = z.record(z.string(), z.number())
export type ToneSignals = z.infer<typeof ToneSignalsSchema>

// ============================================================
// InputPipeline Output
// ============================================================

export const ParsedIntentSchema = z.object({
  intent: z.string(),
  tone_signals: ToneSignalsSchema,
  atomic_actions: z.array(AtomicActionSchema).min(1),
  ambiguity_flags: z.array(z.string()),
})

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>

export const InputPipelineOutputSchema = z.object({
  original_text: z.string(),
  intent: z.string(),
  tone_signals: ToneSignalsSchema,
  atomic_actions: z.array(AtomicActionSchema),
  ambiguity_resolved: z.boolean(),
})

export type InputPipelineOutput = z.infer<typeof InputPipelineOutputSchema>

// ============================================================
// ReflectionPipeline Types
// ============================================================

export const VoiceStance = z.enum(['WARN', 'SUPPORT', 'QUESTION', 'TAUNT'])
export type VoiceStance = z.infer<typeof VoiceStance>

export const VoiceLineSchema = z.object({
  trait_id: z.string(),
  line: z.string(),
  stance: VoiceStance,
})

export type VoiceLine = z.infer<typeof VoiceLineSchema>

export const TraitVoiceOutputSchema = z.object({
  voices: z.array(VoiceLineSchema),
  debate_needed: z.boolean(),
})

export type TraitVoiceOutput = z.infer<typeof TraitVoiceOutputSchema>

export const DebateOutputSchema = z.object({
  debate_lines: z.array(z.object({
    trait_id: z.string(),
    line: z.string(),
  })),
})

export type DebateOutput = z.infer<typeof DebateOutputSchema>

export const InsistenceState = z.enum(['NORMAL', 'WARNED', 'INSISTING'])
export type InsistenceState = z.infer<typeof InsistenceState>

// ============================================================
// ArbitrationPipeline Types
// ============================================================

export const RejectionStrategy = z.enum([
  'NARRATIVE_ABSORB',
  'PARTIAL_EXEC',
  'REINTERPRET',
])
export type RejectionStrategy = z.infer<typeof RejectionStrategy>

export const FeasibilityVerdictSchema = z.object({
  passed: z.boolean(),
  failure_reason: z.string().nullable(),
  rejection_strategy: RejectionStrategy.nullable(),
})

export type FeasibilityVerdict = z.infer<typeof FeasibilityVerdictSchema>

export const ArbitrationResultSchema = z.object({
  passed: z.boolean(),
  action: AtomicActionSchema,
  force_flag: z.boolean(),
  force_level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  drift_flag: z.boolean(),
  rejection_text: z.string().nullable(),
})

export type ArbitrationResult = z.infer<typeof ArbitrationResultSchema>

// ============================================================
// EventPipeline Types
// ============================================================

export const StateChangeSchema = z.object({
  target: z.string(),
  field: z.string(),
  change_description: z.string(),
})

export type StateChange = z.infer<typeof StateChangeSchema>

export const EventGeneratorOutputSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  weight: z.enum(['PRIVATE', 'MINOR', 'SIGNIFICANT', 'MAJOR']),
  summary: z.string(),
  context: z.string(),
  narrative_text: z.string(),
  state_changes: z.array(StateChangeSchema),
})

export type EventGeneratorOutput = z.infer<typeof EventGeneratorOutputSchema>

export const SignalBOutputSchema = z.object({
  choice_signals: z.record(z.string(), z.number()),
})

export type SignalBOutput = z.infer<typeof SignalBOutputSchema>

// ============================================================
// Reachability (LocationGraph)
// ============================================================

export type ReachabilityResult =
  | { reachable: true; total_travel_turns: number }
  | { reachable: false; reason: string }
