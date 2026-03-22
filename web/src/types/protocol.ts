export type ClientMessage =
  | { type: 'initialize' }
  | { type: 'input'; text: string }
  | { type: 'save' }
  | { type: 'ping' }
  | { type: 'reroll_attributes' }
  | { type: 'confirm_attributes'; attributes: Record<string, number> }
  | { type: 'reset' }

export type ServerMessage =
  | { type: 'narrative'; text: string; source: string }
  | { type: 'voices'; voices: Array<{ trait_id: string; line: string }> }
  | { type: 'check'; attribute: string; target: number; roll: number; attribute_value: number; total: number; passed: boolean }
  | { type: 'status'; location: string; turn: number }
  | { type: 'error'; message: string }
  | { type: 'init_progress'; step: string }
  | { type: 'init_complete'; doc: any }
  | { type: 'char_create'; attributes: Record<string, number>; attribute_meta: Array<{ id: string; display_name: string; domain: string }> }
  | { type: 'save_result'; saveId: string }
  | { type: 'save_error'; message: string }
  | { type: 'pong' }
  | { type: 'debug_turn_start'; turn: number; input: string }
  | { type: 'debug_step'; step: string; phase: 'start' | 'end'; status?: string; duration_ms?: number; data?: string }
  | { type: 'debug_state'; states: Record<string, unknown> }
  | { type: 'reset_complete' }
