import { z } from 'zod/v4'
import { PlayerAttributesSchema } from '../domain/models/attributes.js'

// ============================================================
// Client → Server messages
// ============================================================

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('initialize') }),
  z.object({ type: z.literal('input'), text: z.string().min(1) }),
  z.object({ type: z.literal('save') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('reroll_attributes') }),
  z.object({ type: z.literal('confirm_attributes'), attributes: PlayerAttributesSchema }),
  z.object({ type: z.literal('reset') }),
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>

// ============================================================
// Server → Client messages
// ============================================================

export type ServerMessage =
  | { type: 'narrative'; text: string; source: string }
  | { type: 'voices'; voices: Array<{ trait_id: string; line: string }> }
  | { type: 'check'; attribute: string; target: number; roll: number; attribute_value: number; total: number; passed: boolean }
  | { type: 'status'; location: string; turn: number }
  | { type: 'error'; message: string }
  | { type: 'init_progress'; step: string }
  | { type: 'init_complete'; doc: unknown }
  | { type: 'char_create'; attributes: Record<string, number>; attribute_meta: Array<{ id: string; display_name: string; domain: string }> }
  | { type: 'save_result'; saveId: string }
  | { type: 'save_error'; message: string }
  | { type: 'pong' }
  | { type: 'debug_turn_start'; turn: number; input: string }
  | { type: 'debug_step'; step: string; phase: 'start' | 'end'; status?: string; duration_ms?: number; data?: string }
  | { type: 'debug_state'; states: Record<string, unknown> }
  | { type: 'reset_complete' }
