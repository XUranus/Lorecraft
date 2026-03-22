import { create } from 'zustand'
import type { ClientMessage } from '../types/protocol'

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

  // Character creation
  charCreate: CharCreateState | null

  // Debug
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
  setCharCreate: (state: CharCreateState | null) => void
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

  charCreate: null,

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
  setCharCreate: (charCreate) => set({ charCreate }),

  resetGame: () =>
    set({
      narrativeLines: [],
      voices: [],
      location: '',
      turn: 0,
      isProcessing: false,
      inputEnabled: false,
      initDoc: null,
      charCreate: null,
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
