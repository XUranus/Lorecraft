export interface ChoiceForClient {
  text: string
  check?: {
    attribute_id: string
    attribute_display_name: string
    difficulty: string
    pass_chance: number
  }
}

export interface GameplayOptions {
  inner_voice: boolean
  insistence: boolean
  action_arbiter: boolean
  narrative_progress: boolean
  world_assertion: boolean
}

export type ClientMessage =
  | { type: 'initialize' }
  | { type: 'new_game' }
  | { type: 'input'; text: string }
  | { type: 'select_choice'; index: number }
  | { type: 'save' }
  | { type: 'ping' }
  | { type: 'reroll_attributes' }
  | { type: 'confirm_attributes'; attributes: Record<string, number> }
  | { type: 'reset' }
  | { type: 'insist' }
  | { type: 'abandon' }
  | { type: 'retry' }
  | { type: 'select_style'; preset_index: number }
  | { type: 'select_style_custom'; tone: string; narrative_style: string; player_archetype: string }
  | { type: 'get_characters' }
  | { type: 'list_sessions' }
  | { type: 'new_session' }
  | { type: 'switch_session'; session_id: string }
  | { type: 'delete_session'; session_id: string }
  | { type: 'get_llm_config' }
  | { type: 'set_llm_config'; provider: string; api_key: string; model: string; base_url?: string }
  | { type: 'test_llm_config'; provider: string; api_key: string; model: string; base_url?: string }
  | { type: 'list_models'; provider: string; api_key: string; base_url?: string }
  | { type: 'get_gameplay_options' }
  | { type: 'set_gameplay_options'; options: Partial<GameplayOptions> }

export type ServerMessage =
  | { type: 'narrative'; text: string; source: string }
  | { type: 'voices'; voices: Array<{ trait_id: string; line: string }> }
  | { type: 'check'; attribute: string; difficulty: string; base_target: number; modifiers: Array<{ label: string; value: number }>; target: number; roll: number; attribute_value: number; total: number; passed: boolean }
  | { type: 'status'; location: string; turn: number }
  | { type: 'error'; message: string; retryable?: boolean }
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
  | { type: 'history'; messages: ServerMessage[] }
  | { type: 'insistence_prompt' }
  | { type: 'style_select'; presets: Array<{ label: string; description: string }> }
  | { type: 'session_list'; sessions: Array<{ id: string; label: string; turn: number; location: string; updated_at: number }> }
  | { type: 'characters'; player: CharacterInfo; npcs: CharacterInfo[] }
  | { type: 'llm_config'; config: { provider: string; api_key: string; model: string; base_url?: string } }
  | { type: 'llm_config_saved' }
  | { type: 'llm_test_result'; success: boolean; message: string }
  | { type: 'model_list'; models: string[] }
  | { type: 'no_game' }

export interface CharacterInfo {
  id: string
  name: string
  background?: string
  attributes?: Record<string, number>
  // NPC knowledge fields
  first_impression?: string
  known_facts?: string[]
  relationship_to_player?: string
  last_seen_location?: string
  last_seen_emotion?: string
  last_interaction_turn?: number
}
