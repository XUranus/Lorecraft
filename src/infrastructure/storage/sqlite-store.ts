import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initializeSchema } from './sqlite-schema.js'
import type { IStoreFactory, SessionInfo } from './store-factory.js'
import type {
  IEventStore,
  IStateStore,
  ILoreStore,
  ILongTermMemoryStore,
  ISessionStore,
  LongTermMemoryEntry,
} from './interfaces.js'
import type { Event, EventTier1, EventTier2, EventTier3, EventTier4 } from '../../domain/models/event.js'
import type { GameTimestamp } from '../../domain/models/common.js'
import type { LoreEntry } from '../../domain/models/lore.js'
import type { GenesisDocument } from '../../domain/models/genesis.js'
import type { SaveFile } from '../../domain/models/session.js'

// ============================================================
// SQLiteStore — unified persistent store backed by SQLite + FTS5
// ============================================================

function scopeKey(sessionId: string, key: string): string {
  return `session:${sessionId}:${key}`
}

export class SQLiteStore implements IStoreFactory {
  private db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.db = new Database(dbPath)
    initializeSchema(this.db)
  }

  get stateStore(): IStateStore { return this.asStateStore() }
  get eventStore(): IEventStore { return this.asEventStore() }
  get loreStore(): ILoreStore { return this.asLoreStore() }
  get longTermMemoryStore(): ILongTermMemoryStore { return this.asLongTermMemoryStore() }
  get sessionStore(): ISessionStore { return this.asSessionStore() }

  close(): void {
    this.db.close()
  }

  /** Get typed adapter for IEventStore */
  asEventStore(): IEventStore {
    return {
      append: (e) => this.appendEvent(e),
      getTier1: (id) => this.getTier1(id),
      getTier2: (id) => this.getTier2(id),
      getTier3: (id) => this.getTier3(id),
      getTier4: (id) => this.getTier4(id),
      getTiers: (id, t) => this.getTiers(id, t),
      scanByTimeRange: (f, t) => this.scanByTimeRange(f, t),
      scanByParticipant: (n, l) => this.scanByParticipant(n, l),
      getAllTier1: () => this.getAllTier1(),
    }
  }

  /** Get typed adapter for IStateStore */
  asStateStore(): IStateStore {
    return {
      get: <T>(k: string) => this.get<T>(k),
      set: <T>(k: string, v: T) => this.set(k, v),
      delete: (k) => this.delete(k),
      listByPrefix: (p) => this.listByPrefix(p),
    }
  }

  scopedStateStore(sessionId: string): IStateStore {
    return {
      get: <T>(key: string) => this.get<T>(scopeKey(sessionId, key)),
      set: <T>(key: string, value: T) => this.set(scopeKey(sessionId, key), value),
      delete: (key) => this.delete(scopeKey(sessionId, key)),
      listByPrefix: async (prefix) => {
        const keys = await this.listByPrefix(scopeKey(sessionId, prefix))
        return keys.map((key) => key.slice(`session:${sessionId}:`.length))
      },
    }
  }

  /** Get typed adapter for ILoreStore */
  asLoreStore(): ILoreStore {
    return {
      append: (e) => this.appendLore(e),
      findBySubject: (s) => this.findBySubject(s),
      findByContentHash: (h) => this.findByContentHash(h),
      findByFactType: (t) => this.findByFactType(t),
      getById: (id) => this.getById(id),
      update: (id, u) => this.update(id, u),
    }
  }

  /** Get typed adapter for ILongTermMemoryStore */
  asLongTermMemoryStore(): ILongTermMemoryStore {
    return {
      append: (e) => this.appendMemory(e),
      findByParticipant: (n, p, l) => this.findByParticipant(n, p, l),
      findByLocation: (n, loc, l) => this.findByLocation(n, loc, l),
      findRecent: (n, l) => this.findRecent(n, l),
    }
  }

  /** Get typed adapter for ISessionStore */
  asSessionStore(): ISessionStore {
    return {
      saveGenesis: (d) => this.saveGenesis(d),
      loadGenesis: (id) => this.loadGenesis(id),
      saveSaveFile: (s) => this.saveSaveFile(s),
      loadSaveFile: (id) => this.loadSaveFile(id),
      listSaves: (id) => this.listSaves(id),
    }
  }

  scopedEventStore(sessionId: string): IEventStore {
    return {
      append: (event) => this.appendEventForSession(sessionId, event),
      getTier1: (id) => this.getTier1ForSession(sessionId, id),
      getTier2: (id) => this.getTier2ForSession(sessionId, id),
      getTier3: (id) => this.getTier3ForSession(sessionId, id),
      getTier4: (id) => this.getTier4ForSession(sessionId, id),
      getTiers: (id, tiers) => this.getTiersForSession(sessionId, id, tiers),
      scanByTimeRange: (from, to) => this.scanByTimeRangeForSession(sessionId, from, to),
      scanByParticipant: (npcId, limit) => this.scanByParticipantForSession(sessionId, npcId, limit),
      getAllTier1: () => this.getAllTier1ForSession(sessionId),
    }
  }

  scopedLoreStore(sessionId: string): ILoreStore {
    return {
      append: (entry) => this.appendLoreForSession(sessionId, entry),
      findBySubject: (subjectId) => this.findBySubjectForSession(sessionId, subjectId),
      findByContentHash: (hash) => this.findByContentHashForSession(sessionId, hash),
      findByFactType: (type) => this.findByFactTypeForSession(sessionId, type),
      getById: (id) => this.getByIdForSession(sessionId, id),
      update: (id, updates) => this.updateForSession(sessionId, id, updates),
    }
  }

  scopedLongTermMemoryStore(sessionId: string): ILongTermMemoryStore {
    return {
      append: (entry) => this.appendMemoryForSession(sessionId, entry),
      findByParticipant: (npcId, participantId, limit) =>
        this.findByParticipantForSession(sessionId, npcId, participantId, limit),
      findByLocation: (npcId, locationId, limit) =>
        this.findByLocationForSession(sessionId, npcId, locationId, limit),
      findRecent: (npcId, limit) => this.findRecentForSession(sessionId, npcId, limit),
    }
  }

  // ──────────────────────────────────────────────
  // IEventStore
  // ──────────────────────────────────────────────

  async appendEvent(event: Event): Promise<void> {
    return this.appendEventForSession('', event)
  }

  private async appendEventForSession(sessionId: string, event: Event): Promise<void> {
    const insertEvent = this.db.prepare(`
      INSERT OR REPLACE INTO events
        (id, session_id, title, turn, day, hour, location_id, tags, weight, force_level, created_at,
         summary, choice_signals, context, related_event_ids, state_snapshot, narrative_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertParticipant = this.db.prepare(`
      INSERT OR IGNORE INTO event_participants (event_id, npc_id) VALUES (?, ?)
    `)

    this.db.transaction(() => {
      insertEvent.run(
        event.id,
        sessionId,
        event.title,
        event.timestamp.turn,
        event.timestamp.day,
        event.timestamp.hour,
        event.location_id,
        JSON.stringify(event.tags),
        event.weight,
        event.force_level,
        event.created_at,
        event.summary,
        JSON.stringify(event.choice_signals),
        event.context,
        JSON.stringify(event.related_event_ids),
        JSON.stringify(event.state_snapshot),
        event.narrative_text,
      )

      for (const pid of event.participant_ids) {
        insertParticipant.run(event.id, pid)
      }
    })()
  }

  async getTier1(event_id: string): Promise<EventTier1 | null> {
    return this.getTier1ForSession('', event_id)
  }

  private async getTier1ForSession(sessionId: string, event_id: string): Promise<EventTier1 | null> {
    const row = this.db.prepare(`
      SELECT id, title, turn, day, hour, location_id, tags, weight, force_level, created_at
      FROM events WHERE id = ? AND session_id = ?
    `).get(event_id, sessionId) as any
    if (!row) return null
    const participants = this.db.prepare('SELECT npc_id FROM event_participants WHERE event_id = ?')
      .all(event_id) as Array<{ npc_id: string }>
    return this.rowToTier1(row, participants.map(p => p.npc_id))
  }

  async getTier2(event_id: string): Promise<EventTier2 | null> {
    return this.getTier2ForSession('', event_id)
  }

  private async getTier2ForSession(sessionId: string, event_id: string): Promise<EventTier2 | null> {
    const row = this.db.prepare('SELECT summary, choice_signals FROM events WHERE id = ? AND session_id = ?').get(event_id, sessionId) as any
    if (!row) return null
    return { summary: row.summary, choice_signals: JSON.parse(row.choice_signals) }
  }

  async getTier3(event_id: string): Promise<EventTier3 | null> {
    return this.getTier3ForSession('', event_id)
  }

  private async getTier3ForSession(sessionId: string, event_id: string): Promise<EventTier3 | null> {
    const row = this.db.prepare('SELECT context, related_event_ids, state_snapshot FROM events WHERE id = ? AND session_id = ?').get(event_id, sessionId) as any
    if (!row) return null
    return {
      context: row.context,
      related_event_ids: JSON.parse(row.related_event_ids),
      state_snapshot: JSON.parse(row.state_snapshot),
    }
  }

  async getTier4(event_id: string): Promise<EventTier4 | null> {
    return this.getTier4ForSession('', event_id)
  }

  private async getTier4ForSession(sessionId: string, event_id: string): Promise<EventTier4 | null> {
    const row = this.db.prepare('SELECT narrative_text FROM events WHERE id = ? AND session_id = ?').get(event_id, sessionId) as any
    if (!row) return null
    return { narrative_text: row.narrative_text }
  }

  async getTiers(event_id: string, tiers: number[]): Promise<Partial<Event> | null> {
    return this.getTiersForSession('', event_id, tiers)
  }

  private async getTiersForSession(sessionId: string, event_id: string, tiers: number[]): Promise<Partial<Event> | null> {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ? AND session_id = ?').get(event_id, sessionId) as any
    if (!row) return null
    const participants = this.db.prepare('SELECT npc_id FROM event_participants WHERE event_id = ?')
      .all(event_id) as Array<{ npc_id: string }>
    const result: Partial<Event> = {}
    if (tiers.includes(1)) Object.assign(result, this.rowToTier1(row, participants.map(p => p.npc_id)))
    if (tiers.includes(2)) Object.assign(result, { summary: row.summary, choice_signals: JSON.parse(row.choice_signals) })
    if (tiers.includes(3)) Object.assign(result, { context: row.context, related_event_ids: JSON.parse(row.related_event_ids), state_snapshot: JSON.parse(row.state_snapshot) })
    if (tiers.includes(4)) Object.assign(result, { narrative_text: row.narrative_text })
    return result
  }

  async scanByTimeRange(from: GameTimestamp, to: GameTimestamp): Promise<EventTier1[]> {
    return this.scanByTimeRangeForSession('', from, to)
  }

  private async scanByTimeRangeForSession(
    sessionId: string,
    from: GameTimestamp,
    to: GameTimestamp,
  ): Promise<EventTier1[]> {
    const rows = this.db.prepare(`
      SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
      FROM events e LEFT JOIN event_participants ep ON e.id = ep.event_id
      WHERE e.session_id = ? AND e.turn >= ? AND e.turn <= ?
      GROUP BY e.id ORDER BY e.turn
    `).all(sessionId, from.turn, to.turn) as any[]
    return rows.map(r => this.rowToTier1(r, r.participant_csv ? r.participant_csv.split(',') : []))
  }

  async scanByParticipant(npc_id: string, limit: number): Promise<EventTier1[]> {
    return this.scanByParticipantForSession('', npc_id, limit)
  }

  private async scanByParticipantForSession(
    sessionId: string,
    npc_id: string,
    limit: number,
  ): Promise<EventTier1[]> {
    const rows = this.db.prepare(`
      SELECT e.*, GROUP_CONCAT(ep2.npc_id) as participant_csv
      FROM events e
      JOIN event_participants ep ON e.id = ep.event_id AND ep.npc_id = ?
      LEFT JOIN event_participants ep2 ON e.id = ep2.event_id
      WHERE e.session_id = ?
      GROUP BY e.id ORDER BY e.turn DESC LIMIT ?
    `).all(npc_id, sessionId, limit) as any[]
    return rows.map(r => this.rowToTier1(r, r.participant_csv ? r.participant_csv.split(',') : []))
  }

  async getAllTier1(): Promise<EventTier1[]> {
    return this.getAllTier1ForSession('')
  }

  private async getAllTier1ForSession(sessionId: string): Promise<EventTier1[]> {
    const rows = this.db.prepare(`
      SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
      FROM events e LEFT JOIN event_participants ep ON e.id = ep.event_id
      WHERE e.session_id = ?
      GROUP BY e.id ORDER BY e.turn
    `).all(sessionId) as any[]
    return rows.map(r => this.rowToTier1(r, r.participant_csv ? r.participant_csv.split(',') : []))
  }

  private rowToTier1(row: any, participant_ids: string[]): EventTier1 {
    return {
      id: row.id,
      title: row.title,
      timestamp: { day: row.day, hour: row.hour, turn: row.turn },
      location_id: row.location_id,
      participant_ids,
      tags: JSON.parse(row.tags),
      weight: row.weight,
      force_level: row.force_level,
      created_at: row.created_at,
    }
  }

  // ──────────────────────────────────────────────
  // IStateStore (generic KV)
  // ──────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    return JSON.parse(row.value) as T
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, unixepoch())')
      .run(key, JSON.stringify(value))
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key)
  }

  async listByPrefix(prefix: string): Promise<string[]> {
    const rows = this.db.prepare('SELECT key FROM kv_store WHERE key LIKE ?')
      .all(prefix + '%') as Array<{ key: string }>
    return rows.map(r => r.key)
  }

  // ──────────────────────────────────────────────
  // ILoreStore
  // ──────────────────────────────────────────────

  async appendLore(entry: LoreEntry): Promise<void> {
    return this.appendLoreForSession('', entry)
  }

  private async appendLoreForSession(sessionId: string, entry: LoreEntry): Promise<void> {
    const insertLore = this.db.prepare(`
      INSERT OR REPLACE INTO lore
        (id, session_id, content, fact_type, authority_level, source_event_id, created_at_turn,
         causal_chain, related_lore_ids, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertSubject = this.db.prepare('INSERT OR IGNORE INTO lore_subjects (lore_id, subject_id) VALUES (?, ?)')

    this.db.transaction(() => {
      insertLore.run(
        entry.id,
        sessionId,
        entry.content,
        entry.fact_type,
        entry.authority_level,
        entry.source_event_id,
        entry.created_at_turn,
        JSON.stringify(entry.causal_chain),
        JSON.stringify(entry.related_lore_ids),
        entry.content_hash,
      )

      for (const sid of entry.subject_ids) {
        insertSubject.run(entry.id, sid)
      }
    })()
  }

  async findBySubject(subject_id: string): Promise<LoreEntry[]> {
    return this.findBySubjectForSession('', subject_id)
  }

  private async findBySubjectForSession(sessionId: string, subject_id: string): Promise<LoreEntry[]> {
    const rows = this.db.prepare(`
      SELECT l.* FROM lore l
      JOIN lore_subjects ls ON l.id = ls.lore_id
      WHERE l.session_id = ? AND ls.subject_id = ?
    `).all(sessionId, subject_id) as any[]
    return rows.map(r => this.rowToLore(r))
  }

  async findByContentHash(hash: string): Promise<LoreEntry | null> {
    return this.findByContentHashForSession('', hash)
  }

  private async findByContentHashForSession(sessionId: string, hash: string): Promise<LoreEntry | null> {
    const row = this.db.prepare('SELECT * FROM lore WHERE session_id = ? AND content_hash = ?').get(sessionId, hash) as any
    if (!row) return null
    return this.rowToLore(row)
  }

  async findByFactType(fact_type: string): Promise<LoreEntry[]> {
    return this.findByFactTypeForSession('', fact_type)
  }

  private async findByFactTypeForSession(sessionId: string, fact_type: string): Promise<LoreEntry[]> {
    const rows = this.db.prepare('SELECT * FROM lore WHERE session_id = ? AND fact_type = ?').all(sessionId, fact_type) as any[]
    return rows.map(r => this.rowToLore(r))
  }

  async getById(id: string): Promise<LoreEntry | null> {
    return this.getByIdForSession('', id)
  }

  private async getByIdForSession(sessionId: string, id: string): Promise<LoreEntry | null> {
    const row = this.db.prepare('SELECT * FROM lore WHERE id = ? AND session_id = ?').get(id, sessionId) as any
    if (!row) return null
    return this.rowToLore(row)
  }

  async update(id: string, updates: Partial<LoreEntry>): Promise<void> {
    return this.updateForSession('', id, updates)
  }

  private async updateForSession(sessionId: string, id: string, updates: Partial<LoreEntry>): Promise<void> {
    const current = await this.getByIdForSession(sessionId, id)
    if (!current) return
    const merged = { ...current, ...updates }
    await this.appendLoreForSession(sessionId, merged)
  }

  private rowToLore(row: any): LoreEntry {
    const subjects = this.db.prepare('SELECT subject_id FROM lore_subjects WHERE lore_id = ?')
      .all(row.id) as Array<{ subject_id: string }>
    return {
      id: row.id,
      content: row.content,
      fact_type: row.fact_type,
      authority_level: row.authority_level,
      subject_ids: subjects.map(s => s.subject_id),
      source_event_id: row.source_event_id,
      created_at_turn: row.created_at_turn,
      causal_chain: JSON.parse(row.causal_chain),
      related_lore_ids: JSON.parse(row.related_lore_ids),
      content_hash: row.content_hash,
    }
  }

  // ──────────────────────────────────────────────
  // ILongTermMemoryStore
  // ──────────────────────────────────────────────

  async appendMemory(entry: LongTermMemoryEntry): Promise<void> {
    return this.appendMemoryForSession('', entry)
  }

  private async appendMemoryForSession(sessionId: string, entry: LongTermMemoryEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO npc_memories (session_id, npc_id, event_id, subjective_summary, distortion_type, recorded_at_turn, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const insertParticipant = this.db.prepare(
      'INSERT OR IGNORE INTO memory_participants (memory_id, npc_id) VALUES (?, ?)'
    )

    this.db.transaction(() => {
      const result = stmt.run(
        sessionId,
        entry.npc_id,
        entry.event_id,
        entry.subjective_summary,
        entry.distortion_type,
        entry.recorded_at_turn,
        entry.location_id,
      )

      const memoryId = result.lastInsertRowid
      for (const pid of entry.participant_ids) {
        insertParticipant.run(memoryId, pid)
      }
    })()
  }

  async findByParticipant(npc_id: string, participant_id: string, limit: number): Promise<LongTermMemoryEntry[]> {
    return this.findByParticipantForSession('', npc_id, participant_id, limit)
  }

  private async findByParticipantForSession(
    sessionId: string,
    npc_id: string,
    participant_id: string,
    limit: number,
  ): Promise<LongTermMemoryEntry[]> {
    const rows = this.db.prepare(`
      SELECT m.* FROM npc_memories m
      JOIN memory_participants mp ON m.id = mp.memory_id
      WHERE m.session_id = ? AND m.npc_id = ? AND mp.npc_id = ?
      ORDER BY m.recorded_at_turn DESC LIMIT ?
    `).all(sessionId, npc_id, participant_id, limit) as any[]
    return rows.map(r => this.rowToMemory(r))
  }

  async findByLocation(npc_id: string, location_id: string, limit: number): Promise<LongTermMemoryEntry[]> {
    return this.findByLocationForSession('', npc_id, location_id, limit)
  }

  private async findByLocationForSession(
    sessionId: string,
    npc_id: string,
    location_id: string,
    limit: number,
  ): Promise<LongTermMemoryEntry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM npc_memories WHERE session_id = ? AND npc_id = ? AND location_id = ?
      ORDER BY recorded_at_turn DESC LIMIT ?
    `).all(sessionId, npc_id, location_id, limit) as any[]
    return rows.map(r => this.rowToMemory(r))
  }

  async findRecent(npc_id: string, limit: number): Promise<LongTermMemoryEntry[]> {
    return this.findRecentForSession('', npc_id, limit)
  }

  private async findRecentForSession(
    sessionId: string,
    npc_id: string,
    limit: number,
  ): Promise<LongTermMemoryEntry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM npc_memories WHERE session_id = ? AND npc_id = ?
      ORDER BY recorded_at_turn DESC LIMIT ?
    `).all(sessionId, npc_id, limit) as any[]
    return rows.map(r => this.rowToMemory(r))
  }

  private rowToMemory(row: any): LongTermMemoryEntry {
    const participants = this.db.prepare('SELECT npc_id FROM memory_participants WHERE memory_id = ?')
      .all(row.id) as Array<{ npc_id: string }>
    return {
      event_id: row.event_id,
      npc_id: row.npc_id,
      subjective_summary: row.subjective_summary,
      participant_ids: participants.map(p => p.npc_id),
      location_id: row.location_id ?? '',
      recorded_at_turn: row.recorded_at_turn,
      distortion_type: row.distortion_type,
    }
  }

  // ──────────────────────────────────────────────
  // ISessionStore
  // ──────────────────────────────────────────────

  async saveGenesis(doc: GenesisDocument): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO genesis (id, doc) VALUES (?, ?)')
      .run(doc.id, JSON.stringify(doc))
  }

  async loadGenesis(genesis_id: string): Promise<GenesisDocument | null> {
    const row = this.db.prepare('SELECT doc FROM genesis WHERE id = ?').get(genesis_id) as { doc: string } | undefined
    if (!row) return null
    return JSON.parse(row.doc) as GenesisDocument
  }

  async saveSaveFile(save: SaveFile): Promise<void> {
    await this.set(`save:${save.save_id}`, save)
  }

  async loadSaveFile(save_id: string): Promise<SaveFile | null> {
    return this.get<SaveFile>(`save:${save_id}`)
  }

  async listSaves(genesis_id: string): Promise<string[]> {
    const keys = await this.listByPrefix('save:')
    const saves: string[] = []
    for (const key of keys) {
      const save = await this.get<SaveFile>(key)
      if (save && save.genesis_document_id === genesis_id) {
        saves.push(save.save_id)
      }
    }
    return saves
  }

  // ──────────────────────────────────────────────
  // Full-text search queries
  // ──────────────────────────────────────────────

  /**
   * Determine if query is too short for trigram (< 3 chars).
   * Trigram FTS requires at least 3 characters to match.
   */
  private isShortQuery(query: string): boolean {
    return [...query].length < 3
  }

  searchEvents(query: string, limit = 20): Event[] {
    let rows: any[]
    if (this.isShortQuery(query)) {
      rows = this.db.prepare(`
        SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
        FROM events e LEFT JOIN event_participants ep ON e.id = ep.event_id
        WHERE e.title LIKE ? OR e.summary LIKE ? OR e.narrative_text LIKE ?
        GROUP BY e.id ORDER BY e.turn DESC LIMIT ?
      `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit)
    } else {
      rows = this.db.prepare(`
        SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
        FROM events e
        JOIN events_fts f ON e.rowid = f.rowid
        LEFT JOIN event_participants ep ON e.id = ep.event_id
        WHERE events_fts MATCH ?
        GROUP BY e.id ORDER BY e.turn DESC LIMIT ?
      `).all(query, limit)
    }
    return rows.map(r => this.rowToFullEvent(r))
  }

  searchMemories(query: string, npc_id?: string, limit = 20): LongTermMemoryEntry[] {
    let rows: any[]
    if (this.isShortQuery(query)) {
      rows = npc_id
        ? this.db.prepare('SELECT * FROM npc_memories WHERE subjective_summary LIKE ? AND npc_id = ? ORDER BY recorded_at_turn DESC LIMIT ?').all(`%${query}%`, npc_id, limit)
        : this.db.prepare('SELECT * FROM npc_memories WHERE subjective_summary LIKE ? ORDER BY recorded_at_turn DESC LIMIT ?').all(`%${query}%`, limit)
    } else {
      rows = npc_id
        ? this.db.prepare('SELECT m.* FROM npc_memories m JOIN npc_memories_fts f ON m.id = f.rowid WHERE npc_memories_fts MATCH ? AND m.npc_id = ? ORDER BY m.recorded_at_turn DESC LIMIT ?').all(query, npc_id, limit)
        : this.db.prepare('SELECT m.* FROM npc_memories m JOIN npc_memories_fts f ON m.id = f.rowid WHERE npc_memories_fts MATCH ? ORDER BY m.recorded_at_turn DESC LIMIT ?').all(query, limit)
    }
    return rows.map(r => this.rowToMemory(r))
  }

  searchConversations(query: string, npc_id?: string, limit = 20): Array<{ session_id: string; npc_id: string; role: string; content: string; turn_number: number }> {
    if (this.isShortQuery(query)) {
      return npc_id
        ? this.db.prepare('SELECT * FROM conversations WHERE content LIKE ? AND npc_id = ? ORDER BY turn_number DESC LIMIT ?').all(`%${query}%`, npc_id, limit) as any[]
        : this.db.prepare('SELECT * FROM conversations WHERE content LIKE ? ORDER BY turn_number DESC LIMIT ?').all(`%${query}%`, limit) as any[]
    }
    return npc_id
      ? this.db.prepare('SELECT c.* FROM conversations c JOIN conversations_fts f ON c.id = f.rowid WHERE conversations_fts MATCH ? AND c.npc_id = ? ORDER BY c.turn_number DESC LIMIT ?').all(query, npc_id, limit) as any[]
      : this.db.prepare('SELECT c.* FROM conversations c JOIN conversations_fts f ON c.id = f.rowid WHERE conversations_fts MATCH ? ORDER BY c.turn_number DESC LIMIT ?').all(query, limit) as any[]
  }

  searchLore(query: string, limit = 20): LoreEntry[] {
    let rows: any[]
    if (this.isShortQuery(query)) {
      rows = this.db.prepare('SELECT * FROM lore WHERE content LIKE ? ORDER BY created_at_turn DESC LIMIT ?').all(`%${query}%`, limit)
    } else {
      rows = this.db.prepare('SELECT l.* FROM lore l JOIN lore_fts f ON l.rowid = f.rowid WHERE lore_fts MATCH ? ORDER BY l.created_at_turn DESC LIMIT ?').all(query, limit)
    }
    return rows.map(r => this.rowToLore(r))
  }

  // ──────────────────────────────────────────────
  // Convenience query methods for pipeline
  // ──────────────────────────────────────────────

  getRecentEvents(limit: number): Event[] {
    const rows = this.db.prepare(`
      SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
      FROM events e LEFT JOIN event_participants ep ON e.id = ep.event_id
      GROUP BY e.id ORDER BY e.turn DESC LIMIT ?
    `).all(limit) as any[]
    return rows.map(r => this.rowToFullEvent(r))
  }

  getEventsByLocation(location_id: string, limit: number): Event[] {
    const rows = this.db.prepare(`
      SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
      FROM events e LEFT JOIN event_participants ep ON e.id = ep.event_id
      WHERE e.location_id = ?
      GROUP BY e.id ORDER BY e.turn DESC LIMIT ?
    `).all(location_id, limit) as any[]
    return rows.map(r => this.rowToFullEvent(r))
  }

  getNPCsAtLocation(location_id: string): Array<{ npc_id: string; tier: string; current_emotion: string; interaction_count: number }> {
    return this.db.prepare(`
      SELECT npc_id, tier, current_emotion, interaction_count
      FROM npc_states WHERE current_location_id = ? AND is_active = 1
    `).all(location_id) as any[]
  }

  private rowToFullEvent(row: any): Event {
    const participant_ids = row.participant_csv ? row.participant_csv.split(',') : []
    return {
      id: row.id,
      title: row.title,
      timestamp: { day: row.day, hour: row.hour, turn: row.turn },
      location_id: row.location_id,
      participant_ids,
      tags: JSON.parse(row.tags),
      weight: row.weight,
      force_level: row.force_level,
      created_at: row.created_at,
      summary: row.summary,
      choice_signals: JSON.parse(row.choice_signals),
      context: row.context,
      related_event_ids: JSON.parse(row.related_event_ids),
      state_snapshot: JSON.parse(row.state_snapshot),
      narrative_text: row.narrative_text,
    }
  }

  // ──────────────────────────────────────────────
  // Reset (for game reset)
  // ──────────────────────────────────────────────

  clearPlaythroughData(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM event_participants')
      this.db.exec('DELETE FROM events')
      this.db.exec('DELETE FROM npc_states')
      this.db.exec('DELETE FROM memory_participants')
      this.db.exec('DELETE FROM npc_memories')
      this.db.exec('DELETE FROM relationships')
      this.db.exec('DELETE FROM conversations')
      this.db.exec('DELETE FROM lore_subjects')
      this.db.exec('DELETE FROM lore')
      this.db.exec('DELETE FROM injections')
      this.db.prepare(
        "DELETE FROM kv_store WHERE key NOT LIKE 'save:%' AND key NOT LIKE 'session:%'",
      ).run()
    })()
  }

  resetAll(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM event_participants')
      this.db.exec('DELETE FROM events')
      this.db.exec('DELETE FROM npc_states')
      this.db.exec('DELETE FROM memory_participants')
      this.db.exec('DELETE FROM npc_memories')
      this.db.exec('DELETE FROM relationships')
      this.db.exec('DELETE FROM conversations')
      this.db.exec('DELETE FROM lore_subjects')
      this.db.exec('DELETE FROM lore')
      this.db.exec('DELETE FROM injections')
      this.db.exec('DELETE FROM kv_store')
      this.db.exec('DELETE FROM sessions')
      this.db.exec('DELETE FROM genesis')
    })()
  }

  // ──────────────────────────────────────────────
  // Session Management
  // ──────────────────────────────────────────────

  createSession(id: string, genesisId: string, label: string): void {
    this.db.prepare(
      'INSERT INTO sessions (id, genesis_id, label, is_active) VALUES (?, ?, ?, 1)',
    ).run(id, genesisId, label)
    // Deactivate all other sessions
    this.db.prepare('UPDATE sessions SET is_active = 0 WHERE id != ?').run(id)
  }

  updateSession(id: string, updates: { turn?: number; location?: string; label?: string }): void {
    const parts: string[] = ['updated_at = unixepoch()']
    const params: unknown[] = []
    if (updates.turn !== undefined) { parts.push('turn = ?'); params.push(updates.turn) }
    if (updates.location !== undefined) { parts.push('location = ?'); params.push(updates.location) }
    if (updates.label !== undefined) { parts.push('label = ?'); params.push(updates.label) }
    params.push(id)
    this.db.prepare(`UPDATE sessions SET ${parts.join(', ')} WHERE id = ?`).run(...params)
  }

  activateSession(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET is_active = 0').run()
      this.db.prepare('UPDATE sessions SET is_active = 1 WHERE id = ?').run(id)
    })()
  }

  getActiveSession(): SessionInfo | null {
    const row = this.db.prepare(
      'SELECT id, genesis_id, label, turn, location, created_at, updated_at FROM sessions WHERE is_active = 1',
    ).get() as any
    return row ? this.rowToSessionInfo(row) : null
  }

  listSessions(): SessionInfo[] {
    const rows = this.db.prepare(
      'SELECT id, genesis_id, label, turn, location, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
    ).all() as any[]
    return rows.map((r) => this.rowToSessionInfo(r))
  }

  deleteSession(id: string): void {
    // Get the session's genesis_id to check if we need to clean up genesis
    const session = this.db.prepare('SELECT genesis_id FROM sessions WHERE id = ?').get(id) as any
    if (!session) return

    this.db.transaction(() => {
      // Delete all data scoped to this session via kv_store prefix
      this.db.prepare("DELETE FROM kv_store WHERE key LIKE ?").run(`session:${id}:%`)
      this.db.prepare('DELETE FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE session_id = ?)').run(id)
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM memory_participants WHERE memory_id IN (SELECT id FROM npc_memories WHERE session_id = ?)').run(id)
      this.db.prepare('DELETE FROM npc_memories WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM lore_subjects WHERE lore_id IN (SELECT id FROM lore WHERE session_id = ?)').run(id)
      this.db.prepare('DELETE FROM lore WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)

      // Check if any other sessions reference this genesis
      const count = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM sessions WHERE genesis_id = ?',
      ).get(session.genesis_id) as any
      if (count.cnt === 0) {
        this.db.prepare('DELETE FROM genesis WHERE id = ?').run(session.genesis_id)
      }
    })()
  }

  private rowToSessionInfo(row: any): SessionInfo {
    return {
      id: row.id,
      genesis_id: row.genesis_id,
      label: row.label,
      turn: row.turn,
      location: row.location,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}

// SessionInfo is re-exported from store-factory.ts
export type { SessionInfo } from './store-factory.js'
