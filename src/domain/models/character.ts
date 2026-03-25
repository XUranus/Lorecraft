import { z } from 'zod/v4'
import { NPCTier, DistortionType, GoalStatus } from './common.js'

// ============================================================
// Character Dynamic State
// ============================================================

export const GoalQueueEntrySchema = z.object({
  id: z.string(),
  description: z.string(),
  priority: z.number().int().min(1).max(10),
  created_from_event_id: z.string().nullable(),
  status: GoalStatus,
})

export type GoalQueueEntry = z.infer<typeof GoalQueueEntrySchema>

export const CharacterDynamicStateSchema = z.object({
  npc_id: z.string(),
  tier: NPCTier,
  current_emotion: z.string(),
  current_location_id: z.string(),
  interaction_count: z.number().int().nonnegative(),
  is_active: z.boolean(),
  goal_queue: z.array(GoalQueueEntrySchema),
})

export type CharacterDynamicState = z.infer<typeof CharacterDynamicStateSchema>

// ============================================================
// Relationship
// ============================================================

export const RelationshipEntrySchema = z.object({
  from_npc_id: z.string(),
  to_npc_id: z.string(),
  semantic_description: z.string(),
  strength: z.number().min(0).max(1),
  last_updated_event_id: z.string(),
})

export type RelationshipEntry = z.infer<typeof RelationshipEntrySchema>

// ============================================================
// Memory Buffer
// ============================================================

export const MemoryBufferEntrySchema = z.object({
  event_id: z.string(),
  subjective_summary: z.string(),
  distortion_type: DistortionType,
  recorded_at_turn: z.number().int(),
})

export type MemoryBufferEntry = z.infer<typeof MemoryBufferEntrySchema>

export const MemoryBufferSchema = z.object({
  npc_id: z.string(),
  entries: z.array(MemoryBufferEntrySchema),
  max_size: z.number().int().positive(),
})

export type MemoryBuffer = z.infer<typeof MemoryBufferSchema>

// ============================================================
// Conversation History
// ============================================================

export const ConversationTurnSchema = z.object({
  role: z.enum(['PLAYER', 'NPC']),
  content: z.string(),
  turn_number: z.number().int(),
})

export type ConversationTurn = z.infer<typeof ConversationTurnSchema>

export const ConversationHistorySchema = z.object({
  session_id: z.string(),
  npc_id: z.string(),
  turns: z.array(ConversationTurnSchema),
  max_turns: z.number().int().positive(),
})

export type ConversationHistory = z.infer<typeof ConversationHistorySchema>

// ============================================================
// Player Character Knowledge (what the player knows about an NPC)
// ============================================================

export interface CharacterKnowledge {
  npc_id: string
  name: string
  first_impression: string
  known_facts: string[]
  relationship_to_player: string
  last_seen_location: string
  last_seen_emotion: string
  last_interaction_turn: number
}

// ============================================================
// Tier C Template
// ============================================================

export const TierCTemplateSchema = z.object({
  template_id: z.string(),
  type: z.string(),
  personality_sketch: z.string(),
  default_response_style: z.string(),
})

export type TierCTemplate = z.infer<typeof TierCTemplateSchema>
