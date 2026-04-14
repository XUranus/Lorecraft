import { z } from 'zod/v4'

// ============================================================
// Action Types
// ============================================================

export const ActionTypeSchema = z.string().transform((s) => s.toUpperCase())
export type ActionType = string

export const ActionSchema = z.object({
  type: ActionTypeSchema,
  target: z.string().nullable(),
  method: z.string().nullable(),
})

export type Action = z.infer<typeof ActionSchema>

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
  action: ActionSchema,
  ambiguity_flags: z.array(z.string()),
  world_assertions: z.array(z.string()).default([]),
})

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>

export const InputPipelineOutputSchema = z.object({
  original_text: z.string(),
  intent: z.string(),
  tone_signals: ToneSignalsSchema,
  action: ActionSchema,
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

// Combined voice + debate output (VoiceDebateStep)
export const VoiceDebateOutputSchema = z.object({
  voices: z.array(VoiceLineSchema),
  debate_lines: z.array(z.object({
    trait_id: z.string(),
    line: z.string(),
  })).default([]),
})

export type VoiceDebateOutput = z.infer<typeof VoiceDebateOutputSchema>

export const InsistenceState = z.enum(['NORMAL', 'WARNED', 'INSISTING'])
export type InsistenceState = z.infer<typeof InsistenceState>

// ============================================================
// ArbitrationPipeline Types
// ============================================================

export const ArbitrationReportSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({
    dimension: z.string(),
    passed: z.boolean(),
    reason: z.string().nullable(),
  })),
  drift_flag: z.boolean(),
  rejection_narrative: z.string().nullable(),
})

export type ArbitrationReport = z.infer<typeof ArbitrationReportSchema>

// Combined feasibility + check decision (ActionArbiterStep)
export const ActionArbiterOutputSchema = z.object({
  // Feasibility
  passed: z.boolean(),
  checks: z.array(z.object({
    dimension: z.string(),
    passed: z.boolean(),
    reason: z.string().nullable(),
  })),
  drift_flag: z.boolean(),
  rejection_narrative: z.string().nullable(),
  // Skill check
  needs_check: z.boolean(),
  attribute: z.string().nullable(),
  difficulty: z.string().nullable(),
  modifiers: z.array(z.object({ label: z.string(), value: z.number().int() })).nullable(),
  check_reason: z.string().nullable(),
})

export type ActionArbiterOutput = z.infer<typeof ActionArbiterOutputSchema>

export const ArbitrationResultSchema = z.object({
  passed: z.boolean(),
  action: ActionSchema,
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

export const CharacterObservationSchema = z.object({
  npc_name: z.string(),
  observation: z.string(),
  relationship_hint: z.string().optional(),
})

export type CharacterObservation = z.infer<typeof CharacterObservationSchema>

export const ChoiceCheckSchema = z.object({
  attribute_id: z.string(),
  difficulty: z.enum(['TRIVIAL', 'ROUTINE', 'HARD', 'VERY_HARD', 'LEGENDARY']),
})

export type ChoiceCheck = z.infer<typeof ChoiceCheckSchema>

export const ChoiceOptionSchema = z.object({
  text: z.string(),
  check: ChoiceCheckSchema.nullable().default(null),
})

export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>

export const EventGeneratorOutputSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  weight: z.enum(['PRIVATE', 'MINOR', 'SIGNIFICANT', 'MAJOR']),
  summary: z.string(),
  context: z.string(),
  narrative_text: z.string(),
  state_changes: z.array(StateChangeSchema),
  character_observations: z.array(CharacterObservationSchema).default([]),
  choices: z.array(ChoiceOptionSchema).min(2).max(2).default([]),
})

export type EventGeneratorOutput = z.infer<typeof EventGeneratorOutputSchema>

export const PacingCheckOutputSchema = z.object({
  pacing: z.enum(['QUICK', 'NARRATIVE']),
  max_chars: z.number().int().positive().nullable(),
  reasoning: z.string(),
})

export type PacingCheckOutput = z.infer<typeof PacingCheckOutputSchema>

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
