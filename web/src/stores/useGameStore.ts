import { create } from 'zustand'
import type { ClientMessage, CharacterInfo, ChoiceForClient } from '../types/protocol'

export interface NarrativeLine {
  text: string
  cls: string
}

export interface VoiceEntry {
  trait_id: string
  line: string
}

export interface AttributeMeta {
  id: string
  display_name: string
  domain: string
}

export interface CharCreateState {
  attributes: Record<string, number>
  meta: AttributeMeta[]
}

export interface SessionEntry {
  id: string
  label: string
  turn: number
  location: string
  updated_at: number
}

export interface LLMConfigState {
  provider: string
  api_key: string
  model: string
  base_url?: string
}

export interface DebugStepEntry {
  step: string
  phase: 'start' | 'end'
  status?: string
  duration_ms?: number
  data?: string
  timestamp: number
}

export interface DebugTurn {
  turn: number
  input: string
  steps: DebugStepEntry[]
  states: Record<string, unknown> | null
}

interface GameState {
  // Connection
  connectionStatus: 'disconnected' | 'connecting' | 'connected'
  send: (msg: ClientMessage) => void

  // Game
  narrativeLines: NarrativeLine[]
  voices: VoiceEntry[]
  location: string
  turn: number
  isProcessing: boolean
  inputEnabled: boolean
  initDoc: any | null

  // Style selection
  stylePresets: Array<{ label: string; description: string }> | null

  // Character creation
  charCreate: CharCreateState | null

  // Insistence prompt
  insistencePrompt: boolean

  // Retryable error
  retryable: boolean

  // Choices
  choices: ChoiceForClient[] | null

  // Characters
  playerInfo: CharacterInfo | null
  npcList: CharacterInfo[]

  // Sessions
  sessionList: SessionEntry[] | null

  // LLM Settings
  llmConfig: LLMConfigState | null
  settingsOpen: boolean
  llmTestResult: { success: boolean; message: string } | null
  llmModels: string[] | null

  // Debug
  debugInitLog: Array<{ message: string; timestamp: number }>
  debugTurns: DebugTurn[]

  // Actions
  setConnectionStatus: (s: GameState['connectionStatus']) => void
  setSend: (fn: (msg: ClientMessage) => void) => void
  appendNarrative: (text: string, cls: string) => void
  appendVoices: (entries: VoiceEntry[]) => void
  setStatus: (location: string, turn: number) => void
  setProcessing: (v: boolean) => void
  setInputEnabled: (v: boolean) => void
  setInitDoc: (doc: any) => void
  setStylePresets: (presets: Array<{ label: string; description: string }> | null) => void
  setCharCreate: (state: CharCreateState | null) => void
  setInsistencePrompt: (v: boolean) => void
  setRetryable: (v: boolean) => void
  setChoices: (choices: ChoiceForClient[] | null) => void
  setCharacters: (player: CharacterInfo, npcs: CharacterInfo[]) => void
  setSessionList: (sessions: SessionEntry[] | null) => void
  setLLMConfig: (config: LLMConfigState | null) => void
  setSettingsOpen: (v: boolean) => void
  setLLMTestResult: (r: { success: boolean; message: string } | null) => void
  setLLMModels: (models: string[] | null) => void
  appendInitLog: (message: string) => void
  resetGame: () => void
  debugTurnStart: (turn: number, input: string) => void
  debugStepEvent: (entry: DebugStepEntry) => void
  debugSetState: (states: Record<string, unknown>) => void
}

const noop = () => {}

export const useGameStore = create<GameState>((set) => ({
  connectionStatus: 'disconnected',
  send: noop,

  narrativeLines: [],
  voices: [],
  location: '',
  turn: 0,
  isProcessing: false,
  inputEnabled: false,
  initDoc: null,

  stylePresets: null,

  charCreate: null,

  insistencePrompt: false,

  retryable: false,

  choices: null,

  playerInfo: null,
  npcList: [],

  sessionList: null,

  llmConfig: null,
  settingsOpen: false,
  llmTestResult: null,
  llmModels: null,

  debugInitLog: [],
  debugTurns: [],

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setSend: (send) => set({ send }),

  appendNarrative: (text, cls) =>
    set((s) => ({ narrativeLines: [...s.narrativeLines, { text, cls }] })),

  appendVoices: (entries) =>
    set((s) => ({ voices: [...s.voices, ...entries] })),

  setStatus: (location, turn) => set({ location, turn }),
  setProcessing: (isProcessing) => set({ isProcessing }),
  setInputEnabled: (inputEnabled) => set({ inputEnabled }),
  setInitDoc: (initDoc) => set({ initDoc }),
  setStylePresets: (stylePresets) => set({ stylePresets }),
  setCharCreate: (charCreate) => set({ charCreate }),
  setInsistencePrompt: (insistencePrompt) => set({ insistencePrompt }),
  setRetryable: (retryable) => set({ retryable }),
  setChoices: (choices) => set({ choices }),
  setCharacters: (playerInfo, npcList) => set({ playerInfo, npcList }),
  setSessionList: (sessionList) => set({ sessionList }),
  setLLMConfig: (llmConfig) => set({ llmConfig }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLLMTestResult: (llmTestResult) => set({ llmTestResult }),
  setLLMModels: (llmModels) => set({ llmModels }),

  appendInitLog: (message) =>
    set((s) => ({ debugInitLog: [...s.debugInitLog, { message, timestamp: Date.now() }] })),

  resetGame: () =>
    set({
      narrativeLines: [],
      voices: [],
      location: '',
      turn: 0,
      isProcessing: false,
      inputEnabled: false,
      initDoc: null,
      stylePresets: null,
      charCreate: null,
      insistencePrompt: false,
      retryable: false,
      choices: null,
      playerInfo: null,
      npcList: [],
      sessionList: null,
      debugInitLog: [],
      debugTurns: [],
    }),

  debugTurnStart: (turn, input) =>
    set((s) => ({
      debugTurns: [...s.debugTurns, { turn, input, steps: [], states: null }],
    })),

  debugStepEvent: (entry) =>
    set((s) => {
      const turns = [...s.debugTurns]
      const last = turns[turns.length - 1]
      if (last) {
        turns[turns.length - 1] = { ...last, steps: [...last.steps, entry] }
      }
      return { debugTurns: turns }
    }),

  debugSetState: (states) =>
    set((s) => {
      const turns = [...s.debugTurns]
      const last = turns[turns.length - 1]
      if (last) {
        turns[turns.length - 1] = { ...last, states }
      }
      return { debugTurns: turns }
    }),
}))
