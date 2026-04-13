import type { Database as SqlJsDatabase } from 'sql.js'
import { CREATE_TABLES, CREATE_FTS, CREATE_FTS_TRIGGERS } from './sqlite-schema.js'
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
import { loadFromIndexedDB, createPersistScheduler } from './sqljs-persistence.js'

// ============================================================
// Helper: sql.js returns results as { columns: string[], values: any[][] }
// We convert to array of objects for easier use.
// ============================================================

function queryAll(db: SqlJsDatabase, sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql)
  if (params) stmt.bind(params)
  const rows: any[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

function queryOne(db: SqlJsDatabase, sql: string, params?: any[]): any | undefined {
  const stmt = db.prepare(sql)
  if (params) stmt.bind(params)
  let result: any = undefined
  if (stmt.step()) {
    result = stmt.getAsObject()
  }
  stmt.free()
  return result
}

function runSql(db: SqlJsDatabase, sql: string, params?: any[]): void {
  db.run(sql, params)
}

function hasColumn(db: SqlJsDatabase, table: string, column: string): boolean {
  try {
    const stmt = db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`)
    stmt.free()
    return true
  } catch {
    return false
  }
}

// ============================================================
// SqlJsStore — IStoreFactory backed by sql.js (WASM SQLite)
// ============================================================

const SCHEMA_VERSION = 3

function scopeKey(sessionId: string, key: string): string {
  return `session:${sessionId}:${key}`
}

export class SqlJsStore implements IStoreFactory {
  private db: SqlJsDatabase
  private persistScheduler: ReturnType<typeof createPersistScheduler> | null = null

  private constructor(db: SqlJsDatabase) {
    this.db = db
  }

  static async create(initSqlJs: () => Promise<{ Database: new (data?: ArrayLike<number>) => SqlJsDatabase }>): Promise<SqlJsStore> {
    const SQL = await initSqlJs()
    const savedData = await loadFromIndexedDB()
    const db = savedData ? new SQL.Database(savedData) : new SQL.Database()
    const store = new SqlJsStore(db)
    store.initSchema()
    store.persistScheduler = createPersistScheduler(() => store.db.export())
    return store
  }

  /** For testing: create from an existing sql.js Database instance */
  static fromDatabase(db: SqlJsDatabase): SqlJsStore {
    const store = new SqlJsStore(db)
    store.initSchema()
    return store
  }

  private initSchema(): void {
    // Check current version
    this.db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = queryOne(this.db, 'SELECT value FROM meta WHERE key = ?', ['schema_version'])
    const currentVersion = row ? parseInt(row.value, 10) : 0

    this.db.run(CREATE_TABLES)

    // FTS5 is not available in default sql.js builds — try and skip if unavailable
    try {
      this.db.run(CREATE_FTS)
      for (const block of CREATE_FTS_TRIGGERS.split(/(?=CREATE TRIGGER)/)) {
        const trimmed = block.trim()
        if (trimmed) this.db.run(trimmed)
      }
    } catch {
      // FTS5 not compiled in — full-text search won't be available but core functionality works
    }

    let migratedToSessionScope = false
    if (!hasColumn(this.db, 'events', 'session_id')) {
      this.db.run("ALTER TABLE events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''")
      migratedToSessionScope = true
    }
    if (!hasColumn(this.db, 'npc_memories', 'session_id')) {
      this.db.run("ALTER TABLE npc_memories ADD COLUMN session_id TEXT NOT NULL DEFAULT ''")
      migratedToSessionScope = true
    }
    if (!hasColumn(this.db, 'lore', 'session_id')) {
      this.db.run("ALTER TABLE lore ADD COLUMN session_id TEXT NOT NULL DEFAULT ''")
      migratedToSessionScope = true
    }

    this.db.run('CREATE INDEX IF NOT EXISTS idx_events_session_turn ON events(session_id, turn)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_mem_session_npc ON npc_memories(session_id, npc_id, recorded_at_turn)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_lore_session_hash ON lore(session_id, content_hash)')

    if (currentVersion < 3 || migratedToSessionScope) {
      this.db.run('DELETE FROM event_participants')
      this.db.run('DELETE FROM events')
      this.db.run('DELETE FROM memory_participants')
      this.db.run('DELETE FROM npc_memories')
      this.db.run('DELETE FROM lore_subjects')
      this.db.run('DELETE FROM lore')
      this.db.run("DELETE FROM kv_store WHERE key NOT LIKE 'save:%' AND key NOT LIKE 'session:%'")
    }

    this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)])
  }

  private schedulePersist(): void {
    this.persistScheduler?.schedulePersist()
  }

  dispose(): void {
    this.persistScheduler?.dispose()
    this.db.close()
  }

  /** Export the database as a Uint8Array */
  export(): Uint8Array {
    return this.db.export()
  }

  // ──────────────────────────────────────────────
  // IStoreFactory getters
  // ──────────────────────────────────────────────

  get stateStore(): IStateStore {
    return {
      get: <T>(k: string) => this.get<T>(k),
      set: <T>(k: string, v: T) => this.set(k, v),
      delete: (k) => this.del(k),
      listByPrefix: (p) => this.listByPrefix(p),
    }
  }

  get eventStore(): IEventStore {
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

  get loreStore(): ILoreStore {
    return {
      append: (e) => this.appendLore(e),
      findBySubject: (s) => this.findBySubject(s),
      findByContentHash: (h) => this.findByContentHash(h),
      findByFactType: (t) => this.findByFactType(t),
      getById: (id) => this.getById(id),
      update: (id, u) => this.update(id, u),
    }
  }

  get longTermMemoryStore(): ILongTermMemoryStore {
    return {
      append: (e) => this.appendMemory(e),
      findByParticipant: (n, p, l) => this.findByParticipant(n, p, l),
      findByLocation: (n, loc, l) => this.findByLocation(n, loc, l),
      findRecent: (n, l) => this.findRecent(n, l),
    }
  }

  get sessionStore(): ISessionStore {
    return {
      saveGenesis: (d) => this.saveGenesis(d),
      loadGenesis: (id) => this.loadGenesis(id),
      saveSaveFile: (s) => this.saveSaveFile(s),
      loadSaveFile: (id) => this.loadSaveFile(id),
      listSaves: (id) => this.listSaves(id),
    }
  }

  scopedStateStore(sessionId: string): IStateStore {
    return {
      get: <T>(key: string) => this.get<T>(scopeKey(sessionId, key)),
      set: <T>(key: string, value: T) => this.set(scopeKey(sessionId, key), value),
      delete: (key) => this.del(scopeKey(sessionId, key)),
      listByPrefix: async (prefix) => {
        const keys = await this.listByPrefix(scopeKey(sessionId, prefix))
        return keys.map((key) => key.slice(`session:${sessionId}:`.length))
      },
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
    runSql(this.db, `
      INSERT OR REPLACE INTO events
        (id, session_id, title, turn, day, hour, location_id, tags, weight, force_level, created_at,
         summary, choice_signals, context, related_event_ids, state_snapshot, narrative_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      event.id, sessionId, event.title, event.timestamp.turn, event.timestamp.day, event.timestamp.hour,
      event.location_id, JSON.stringify(event.tags), event.weight, event.force_level, event.created_at,
      event.summary, JSON.stringify(event.choice_signals), event.context,
      JSON.stringify(event.related_event_ids), JSON.stringify(event.state_snapshot), event.narrative_text,
    ])
    for (const pid of event.participant_ids) {
      runSql(this.db, 'INSERT OR IGNORE INTO event_participants (event_id, npc_id) VALUES (?, ?)', [event.id, pid])
    }
    this.schedulePersist()
  }

  async getTier1(event_id: string): Promise<EventTier1 | null> {
    return this.getTier1ForSession('', event_id)
  }

  private async getTier1ForSession(sessionId: string, event_id: string): Promise<EventTier1 | null> {
    const row = queryOne(this.db, `
      SELECT id, title, turn, day, hour, location_id, tags, weight, force_level, created_at
      FROM events WHERE id = ? AND session_id = ?
    `, [event_id, sessionId])
    if (!row) return null
    const participants = queryAll(this.db, 'SELECT npc_id FROM event_participants WHERE event_id = ?', [event_id])
    return this.rowToTier1(row, participants.map((p: any) => p.npc_id))
  }

  async getTier2(event_id: string): Promise<EventTier2 | null> {
    return this.getTier2ForSession('', event_id)
  }

  private async getTier2ForSession(sessionId: string, event_id: string): Promise<EventTier2 | null> {
    const row = queryOne(this.db, 'SELECT summary, choice_signals FROM events WHERE id = ? AND session_id = ?', [event_id, sessionId])
    if (!row) return null
    return { summary: row.summary, choice_signals: JSON.parse(row.choice_signals) }
  }

  async getTier3(event_id: string): Promise<EventTier3 | null> {
    return this.getTier3ForSession('', event_id)
  }

  private async getTier3ForSession(sessionId: string, event_id: string): Promise<EventTier3 | null> {
    const row = queryOne(this.db, 'SELECT context, related_event_ids, state_snapshot FROM events WHERE id = ? AND session_id = ?', [event_id, sessionId])
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
    const row = queryOne(this.db, 'SELECT narrative_text FROM events WHERE id = ? AND session_id = ?', [event_id, sessionId])
    if (!row) return null
    return { narrative_text: row.narrative_text }
  }

  async getTiers(event_id: string, tiers: number[]): Promise<Partial<Event> | null> {
    return this.getTiersForSession('', event_id, tiers)
  }

  private async getTiersForSession(sessionId: string, event_id: string, tiers: number[]): Promise<Partial<Event> | null> {
    const row = queryOne(this.db, 'SELECT * FROM events WHERE id = ? AND session_id = ?', [event_id, sessionId])
    if (!row) return null
    const participants = queryAll(this.db, 'SELECT npc_id FROM event_participants WHERE event_id = ?', [event_id])
    const result: Partial<Event> = {}
    if (tiers.includes(1)) Object.assign(result, this.rowToTier1(row, participants.map((p: any) => p.npc_id)))
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
    const rows = queryAll(this.db, `
      SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
      FROM events e LEFT JOIN event_participants ep ON e.id = ep.event_id
      WHERE e.session_id = ? AND e.turn >= ? AND e.turn <= ?
      GROUP BY e.id ORDER BY e.turn
    `, [sessionId, from.turn, to.turn])
    return rows.map((r: any) => this.rowToTier1(r, r.participant_csv ? r.participant_csv.split(',') : []))
  }

  async scanByParticipant(npc_id: string, limit: number): Promise<EventTier1[]> {
    return this.scanByParticipantForSession('', npc_id, limit)
  }

  private async scanByParticipantForSession(
    sessionId: string,
    npc_id: string,
    limit: number,
  ): Promise<EventTier1[]> {
    const rows = queryAll(this.db, `
      SELECT e.*, GROUP_CONCAT(ep2.npc_id) as participant_csv
      FROM events e
      JOIN event_participants ep ON e.id = ep.event_id AND ep.npc_id = ?
      LEFT JOIN event_participants ep2 ON e.id = ep2.event_id
      WHERE e.session_id = ?
      GROUP BY e.id ORDER BY e.turn DESC LIMIT ?
    `, [npc_id, sessionId, limit])
    return rows.map((r: any) => this.rowToTier1(r, r.participant_csv ? r.participant_csv.split(',') : []))
  }

  async getAllTier1(): Promise<EventTier1[]> {
    return this.getAllTier1ForSession('')
  }

  private async getAllTier1ForSession(sessionId: string): Promise<EventTier1[]> {
    const rows = queryAll(this.db, `
      SELECT e.*, GROUP_CONCAT(ep.npc_id) as participant_csv
      FROM events e LEFT JOIN event_participants ep ON e.id = ep.event_id
      WHERE e.session_id = ?
      GROUP BY e.id ORDER BY e.turn
    `, [sessionId])
    return rows.map((r: any) => this.rowToTier1(r, r.participant_csv ? r.participant_csv.split(',') : []))
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
    const row = queryOne(this.db, 'SELECT value FROM kv_store WHERE key = ?', [key])
    if (!row) return null
    return JSON.parse(row.value) as T
  }

  async set<T>(key: string, value: T): Promise<void> {
    runSql(this.db, 'INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, unixepoch())', [key, JSON.stringify(value)])
    this.schedulePersist()
  }

  async del(key: string): Promise<void> {
    runSql(this.db, 'DELETE FROM kv_store WHERE key = ?', [key])
    this.schedulePersist()
  }

  async listByPrefix(prefix: string): Promise<string[]> {
    const rows = queryAll(this.db, 'SELECT key FROM kv_store WHERE key LIKE ?', [prefix + '%'])
    return rows.map((r: any) => r.key)
  }

  // ──────────────────────────────────────────────
  // ILoreStore
  // ──────────────────────────────────────────────

  async appendLore(entry: LoreEntry): Promise<void> {
    return this.appendLoreForSession('', entry)
  }

  private async appendLoreForSession(sessionId: string, entry: LoreEntry): Promise<void> {
    runSql(this.db, `
      INSERT OR REPLACE INTO lore
        (id, session_id, content, fact_type, authority_level, source_event_id, created_at_turn,
         causal_chain, related_lore_ids, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.id, sessionId, entry.content, entry.fact_type, entry.authority_level,
      entry.source_event_id, entry.created_at_turn,
      JSON.stringify(entry.causal_chain), JSON.stringify(entry.related_lore_ids), entry.content_hash,
    ])
    for (const sid of entry.subject_ids) {
      runSql(this.db, 'INSERT OR IGNORE INTO lore_subjects (lore_id, subject_id) VALUES (?, ?)', [entry.id, sid])
    }
    this.schedulePersist()
  }

  async findBySubject(subject_id: string): Promise<LoreEntry[]> {
    return this.findBySubjectForSession('', subject_id)
  }

  private async findBySubjectForSession(sessionId: string, subject_id: string): Promise<LoreEntry[]> {
    const rows = queryAll(this.db, `
      SELECT l.* FROM lore l
      JOIN lore_subjects ls ON l.id = ls.lore_id
      WHERE l.session_id = ? AND ls.subject_id = ?
    `, [sessionId, subject_id])
    return rows.map((r: any) => this.rowToLore(r))
  }

  async findByContentHash(hash: string): Promise<LoreEntry | null> {
    return this.findByContentHashForSession('', hash)
  }

  private async findByContentHashForSession(sessionId: string, hash: string): Promise<LoreEntry | null> {
    const row = queryOne(this.db, 'SELECT * FROM lore WHERE session_id = ? AND content_hash = ?', [sessionId, hash])
    if (!row) return null
    return this.rowToLore(row)
  }

  async findByFactType(fact_type: string): Promise<LoreEntry[]> {
    return this.findByFactTypeForSession('', fact_type)
  }

  private async findByFactTypeForSession(sessionId: string, fact_type: string): Promise<LoreEntry[]> {
    const rows = queryAll(this.db, 'SELECT * FROM lore WHERE session_id = ? AND fact_type = ?', [sessionId, fact_type])
    return rows.map((r: any) => this.rowToLore(r))
  }

  async getById(id: string): Promise<LoreEntry | null> {
    return this.getByIdForSession('', id)
  }

  private async getByIdForSession(sessionId: string, id: string): Promise<LoreEntry | null> {
    const row = queryOne(this.db, 'SELECT * FROM lore WHERE id = ? AND session_id = ?', [id, sessionId])
    if (!row) return null
    return this.rowToLore(row)
  }

  async update(id: string, updates: Partial<LoreEntry>): Promise<void> {
    return this.updateForSession('', id, updates)
  }

  private async updateForSession(sessionId: string, id: string, updates: Partial<LoreEntry>): Promise<void> {
    const current = await this.getByIdForSession(sessionId, id)
    if (!current) return
    await this.appendLoreForSession(sessionId, { ...current, ...updates })
  }

  private rowToLore(row: any): LoreEntry {
    const subjects = queryAll(this.db, 'SELECT subject_id FROM lore_subjects WHERE lore_id = ?', [row.id])
    return {
      id: row.id,
      content: row.content,
      fact_type: row.fact_type,
      authority_level: row.authority_level,
      subject_ids: subjects.map((s: any) => s.subject_id),
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
    runSql(this.db, `
      INSERT INTO npc_memories (session_id, npc_id, event_id, subjective_summary, distortion_type, recorded_at_turn, location_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [sessionId, entry.npc_id, entry.event_id, entry.subjective_summary, entry.distortion_type, entry.recorded_at_turn, entry.location_id])

    // Get the inserted row id for participant links
    const lastRow = queryOne(this.db, 'SELECT last_insert_rowid() as id')
    const memoryId = lastRow?.id
    if (memoryId) {
      for (const pid of entry.participant_ids) {
        runSql(this.db, 'INSERT OR IGNORE INTO memory_participants (memory_id, npc_id) VALUES (?, ?)', [memoryId, pid])
      }
    }
    this.schedulePersist()
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
    const rows = queryAll(this.db, `
      SELECT m.* FROM npc_memories m
      JOIN memory_participants mp ON m.id = mp.memory_id
      WHERE m.session_id = ? AND m.npc_id = ? AND mp.npc_id = ?
      ORDER BY m.recorded_at_turn DESC LIMIT ?
    `, [sessionId, npc_id, participant_id, limit])
    return rows.map((r: any) => this.rowToMemory(r))
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
    const rows = queryAll(this.db, `
      SELECT * FROM npc_memories WHERE session_id = ? AND npc_id = ? AND location_id = ?
      ORDER BY recorded_at_turn DESC LIMIT ?
    `, [sessionId, npc_id, location_id, limit])
    return rows.map((r: any) => this.rowToMemory(r))
  }

  async findRecent(npc_id: string, limit: number): Promise<LongTermMemoryEntry[]> {
    return this.findRecentForSession('', npc_id, limit)
  }

  private async findRecentForSession(
    sessionId: string,
    npc_id: string,
    limit: number,
  ): Promise<LongTermMemoryEntry[]> {
    const rows = queryAll(this.db, `
      SELECT * FROM npc_memories WHERE session_id = ? AND npc_id = ?
      ORDER BY recorded_at_turn DESC LIMIT ?
    `, [sessionId, npc_id, limit])
    return rows.map((r: any) => this.rowToMemory(r))
  }

  private rowToMemory(row: any): LongTermMemoryEntry {
    const participants = queryAll(this.db, 'SELECT npc_id FROM memory_participants WHERE memory_id = ?', [row.id])
    return {
      event_id: row.event_id,
      npc_id: row.npc_id,
      subjective_summary: row.subjective_summary,
      participant_ids: participants.map((p: any) => p.npc_id),
      location_id: row.location_id ?? '',
      recorded_at_turn: row.recorded_at_turn,
      distortion_type: row.distortion_type,
    }
  }

  // ──────────────────────────────────────────────
  // ISessionStore
  // ──────────────────────────────────────────────

  async saveGenesis(doc: GenesisDocument): Promise<void> {
    runSql(this.db, 'INSERT OR REPLACE INTO genesis (id, doc) VALUES (?, ?)', [doc.id, JSON.stringify(doc)])
    this.schedulePersist()
  }

  async loadGenesis(genesis_id: string): Promise<GenesisDocument | null> {
    const row = queryOne(this.db, 'SELECT doc FROM genesis WHERE id = ?', [genesis_id])
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
  // Session Management
  // ──────────────────────────────────────────────

  createSession(id: string, genesisId: string, label: string): void {
    runSql(this.db, 'INSERT INTO sessions (id, genesis_id, label, is_active) VALUES (?, ?, ?, 1)', [id, genesisId, label])
    runSql(this.db, 'UPDATE sessions SET is_active = 0 WHERE id != ?', [id])
    this.schedulePersist()
  }

  updateSession(id: string, updates: { turn?: number; location?: string; label?: string }): void {
    const parts: string[] = ['updated_at = unixepoch()']
    const params: any[] = []
    if (updates.turn !== undefined) { parts.push('turn = ?'); params.push(updates.turn) }
    if (updates.location !== undefined) { parts.push('location = ?'); params.push(updates.location) }
    if (updates.label !== undefined) { parts.push('label = ?'); params.push(updates.label) }
    params.push(id)
    runSql(this.db, `UPDATE sessions SET ${parts.join(', ')} WHERE id = ?`, params)
    this.schedulePersist()
  }

  activateSession(id: string): void {
    runSql(this.db, 'UPDATE sessions SET is_active = 0', [])
    runSql(this.db, 'UPDATE sessions SET is_active = 1 WHERE id = ?', [id])
    this.schedulePersist()
  }

  getActiveSession(): SessionInfo | null {
    const row = queryOne(this.db,
      'SELECT id, genesis_id, label, turn, location, created_at, updated_at FROM sessions WHERE is_active = 1',
    )
    return row ? this.rowToSessionInfo(row) : null
  }

  listSessions(): SessionInfo[] {
    const rows = queryAll(this.db,
      'SELECT id, genesis_id, label, turn, location, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
    )
    return rows.map((r: any) => this.rowToSessionInfo(r))
  }

  deleteSession(id: string): void {
    const session = queryOne(this.db, 'SELECT genesis_id FROM sessions WHERE id = ?', [id])
    if (!session) return

    runSql(this.db, "DELETE FROM kv_store WHERE key LIKE ?", [`session:${id}:%`])
    runSql(this.db, 'DELETE FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE session_id = ?)', [id])
    runSql(this.db, 'DELETE FROM events WHERE session_id = ?', [id])
    runSql(this.db, 'DELETE FROM memory_participants WHERE memory_id IN (SELECT id FROM npc_memories WHERE session_id = ?)', [id])
    runSql(this.db, 'DELETE FROM npc_memories WHERE session_id = ?', [id])
    runSql(this.db, 'DELETE FROM lore_subjects WHERE lore_id IN (SELECT id FROM lore WHERE session_id = ?)', [id])
    runSql(this.db, 'DELETE FROM lore WHERE session_id = ?', [id])
    runSql(this.db, 'DELETE FROM sessions WHERE id = ?', [id])

    const count = queryOne(this.db, 'SELECT COUNT(*) as cnt FROM sessions WHERE genesis_id = ?', [session.genesis_id])
    if (count.cnt === 0) {
      runSql(this.db, 'DELETE FROM genesis WHERE id = ?', [session.genesis_id])
    }
    this.schedulePersist()
  }

  clearPlaythroughData(): void {
    const tables = [
      'event_participants', 'events', 'npc_states', 'memory_participants',
      'npc_memories', 'relationships', 'conversations', 'lore_subjects',
      'lore', 'injections',
    ]
    for (const table of tables) {
      runSql(this.db, `DELETE FROM ${table}`)
    }
    runSql(
      this.db,
      "DELETE FROM kv_store WHERE key NOT LIKE 'save:%' AND key NOT LIKE 'session:%'",
    )
    this.schedulePersist()
  }

  resetAll(): void {
    const tables = [
      'event_participants', 'events', 'npc_states', 'memory_participants',
      'npc_memories', 'relationships', 'conversations', 'lore_subjects',
      'lore', 'injections', 'kv_store', 'sessions', 'genesis',
    ]
    for (const table of tables) {
      runSql(this.db, `DELETE FROM ${table}`)
    }
    this.schedulePersist()
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
