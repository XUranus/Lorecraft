import type { IStateStore, IEventStore, ILoreStore, ILongTermMemoryStore, ISessionStore } from './interfaces.js'

export interface SessionInfo {
  id: string
  genesis_id: string
  label: string
  turn: number
  location: string
  created_at: number
  updated_at: number
}

export interface IStoreFactory {
  readonly stateStore: IStateStore
  readonly eventStore: IEventStore
  readonly loreStore: ILoreStore
  readonly longTermMemoryStore: ILongTermMemoryStore
  readonly sessionStore: ISessionStore

  createSession(id: string, genesisId: string, label: string): void
  updateSession(id: string, updates: { turn?: number; location?: string; label?: string }): void
  activateSession(id: string): void
  listSessions(): SessionInfo[]
  getActiveSession(): SessionInfo | null
  deleteSession(id: string): void
  scopedStateStore(sessionId: string): IStateStore
  scopedEventStore(sessionId: string): IEventStore
  scopedLoreStore(sessionId: string): ILoreStore
  scopedLongTermMemoryStore(sessionId: string): ILongTermMemoryStore
  clearPlaythroughData(): void
  resetAll(): void
}
