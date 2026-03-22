import { z } from 'zod/v4'
import { PlayerAttributesSchema } from './attributes.js'

// ============================================================
// Genesis Document Sub-types
// ============================================================

export const FactionDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  initial_strength: z.enum(['WEAK', 'MODERATE', 'STRONG', 'DOMINANT']),
  initial_resources: z.string(),
  initial_relationships: z.record(z.string(), z.object({
    relation_type: z.enum(['ALLIED', 'NEUTRAL', 'HOSTILE', 'UNKNOWN']),
    description: z.string(),
  })),
})

export type FactionDefinition = z.infer<typeof FactionDefinitionSchema>

export const IncitingEventSchema = z.object({
  title: z.string(),
  description: z.string(),
  location_id: z.string(),
  participant_ids: z.array(z.string()),
  narrative_text: z.string(),
})

export type IncitingEvent = z.infer<typeof IncitingEventSchema>

export const NarrativePhaseSchema = z.object({
  phase_id: z.string(),
  description: z.string(),
  direction_summary: z.string(),
})

export type NarrativePhase = z.infer<typeof NarrativePhaseSchema>

export const PlayerCharacterDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  background: z.string(),
  attributes: PlayerAttributesSchema.optional(),
})

export type PlayerCharacterDefinition = z.infer<typeof PlayerCharacterDefinitionSchema>

export const TierANPCDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  background: z.string(),
  surface_motivation: z.string(),
  deep_motivation: z.string(),
  secrets: z.array(z.string()),
  initial_relationships: z.record(z.string(), z.string()),
})

export type TierANPCDefinition = z.infer<typeof TierANPCDefinitionSchema>

export const TierBNPCDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  background: z.string(),
  role_description: z.string(),
})

export type TierBNPCDefinition = z.infer<typeof TierBNPCDefinitionSchema>

export const LocationDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  region_id: z.string(),
  description: z.string(),
  initial_status: z.string(),
  connections: z.array(z.object({
    to_location_id: z.string(),
    traversal_condition: z.enum(['OPEN', 'REQUIRES_KEY', 'REQUIRES_EVENT', 'BLOCKED']),
    condition_detail: z.string().nullable(),
    travel_time_turns: z.number().int().nonnegative(),
  })),
})

export type LocationDefinition = z.infer<typeof LocationDefinitionSchema>

// ============================================================
// Genesis Document
// ============================================================

export const GenesisDocumentSchema = z.object({
  id: z.string(),
  created_at: z.number(),

  world_setting: z.object({
    background: z.string(),
    tone: z.string(),
    core_conflict: z.string(),
    hidden_secrets: z.array(z.string()),
    factions: z.array(FactionDefinitionSchema),
  }),

  narrative_structure: z.object({
    final_goal_description: z.string(),
    inciting_event: IncitingEventSchema,
    phases: z.array(NarrativePhaseSchema).min(1),
  }),

  characters: z.object({
    player_character: PlayerCharacterDefinitionSchema,
    tier_a_npcs: z.array(TierANPCDefinitionSchema).min(3).max(7),
    tier_b_npcs: z.array(TierBNPCDefinitionSchema),
  }),

  initial_locations: z.array(LocationDefinitionSchema).min(1),
})

export type GenesisDocument = z.infer<typeof GenesisDocumentSchema>
