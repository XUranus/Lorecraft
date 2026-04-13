// Duck-typed database interface for both better-sqlite3 and sql.js
export interface ISchemaDatabase {
  exec(sql: string): void
  prepare(sql: string): { get(...params: any[]): any; run(...params: any[]): any }
  pragma?(sql: string): any
}

// ============================================================
// Schema version — bump when adding migrations
// ============================================================
const SCHEMA_VERSION = 3

// ============================================================
// Table creation SQL
// ============================================================

const CREATE_TABLES = `
-- Meta KV
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Genesis document
CREATE TABLE IF NOT EXISTS genesis (
    id  TEXT PRIMARY KEY,
    doc TEXT NOT NULL
);

-- Sessions (each session = one playthrough of a genesis)
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    genesis_id  TEXT NOT NULL REFERENCES genesis(id),
    label       TEXT NOT NULL DEFAULT '',
    turn        INTEGER NOT NULL DEFAULT 1,
    location    TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    is_active   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- Generic KV store (replaces StateStore)
CREATE TABLE IF NOT EXISTS kv_store (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Events (4-tier combined)
CREATE TABLE IF NOT EXISTS events (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL DEFAULT '',
    title             TEXT NOT NULL,
    turn              INTEGER NOT NULL,
    day               INTEGER NOT NULL DEFAULT 0,
    hour              INTEGER NOT NULL DEFAULT 0,
    location_id       TEXT NOT NULL,
    tags              TEXT NOT NULL DEFAULT '[]',
    weight            TEXT NOT NULL,
    force_level       INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,

    summary           TEXT NOT NULL DEFAULT '',
    choice_signals    TEXT NOT NULL DEFAULT '{}',

    context           TEXT NOT NULL DEFAULT '',
    related_event_ids TEXT NOT NULL DEFAULT '[]',
    state_snapshot    TEXT NOT NULL DEFAULT '{}',

    narrative_text    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn);
CREATE INDEX IF NOT EXISTS idx_events_location ON events(location_id);
CREATE INDEX IF NOT EXISTS idx_events_session_turn ON events(session_id, turn);

-- Event participants (many-to-many)
CREATE TABLE IF NOT EXISTS event_participants (
    event_id TEXT NOT NULL REFERENCES events(id),
    npc_id   TEXT NOT NULL,
    PRIMARY KEY (event_id, npc_id)
);

CREATE INDEX IF NOT EXISTS idx_ep_npc ON event_participants(npc_id);

-- NPC states
CREATE TABLE IF NOT EXISTS npc_states (
    npc_id              TEXT PRIMARY KEY,
    tier                TEXT NOT NULL,
    current_emotion     TEXT NOT NULL DEFAULT '',
    current_location_id TEXT NOT NULL DEFAULT '',
    interaction_count   INTEGER NOT NULL DEFAULT 0,
    is_active           INTEGER NOT NULL DEFAULT 1,
    goal_queue          TEXT NOT NULL DEFAULT '[]',
    template            TEXT,
    updated_at_turn     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_npc_location ON npc_states(current_location_id);
CREATE INDEX IF NOT EXISTS idx_npc_tier ON npc_states(tier);

-- NPC memories (full history, never compressed)
CREATE TABLE IF NOT EXISTS npc_memories (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL DEFAULT '',
    npc_id             TEXT NOT NULL,
    event_id           TEXT NOT NULL,
    subjective_summary TEXT NOT NULL,
    distortion_type    TEXT NOT NULL,
    recorded_at_turn   INTEGER NOT NULL,
    location_id        TEXT,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mem_npc ON npc_memories(npc_id, recorded_at_turn);
CREATE INDEX IF NOT EXISTS idx_mem_event ON npc_memories(event_id);
CREATE INDEX IF NOT EXISTS idx_mem_session_npc ON npc_memories(session_id, npc_id, recorded_at_turn);

-- Memory participants (who is mentioned in a memory)
CREATE TABLE IF NOT EXISTS memory_participants (
    memory_id INTEGER NOT NULL REFERENCES npc_memories(id),
    npc_id    TEXT NOT NULL,
    PRIMARY KEY (memory_id, npc_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_npc ON memory_participants(npc_id);

-- Relationships
CREATE TABLE IF NOT EXISTS relationships (
    from_npc_id           TEXT NOT NULL,
    to_npc_id             TEXT NOT NULL,
    semantic_description  TEXT NOT NULL,
    strength              REAL NOT NULL,
    last_updated_event_id TEXT NOT NULL,
    updated_at_turn       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (from_npc_id, to_npc_id)
);

-- Conversations (full history)
CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    npc_id      TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    turn_number INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_session_npc ON conversations(session_id, npc_id, turn_number);

-- Lore entries
CREATE TABLE IF NOT EXISTS lore (
    id               TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL DEFAULT '',
    content          TEXT NOT NULL,
    fact_type        TEXT NOT NULL,
    authority_level  TEXT NOT NULL,
    source_event_id  TEXT,
    created_at_turn  INTEGER NOT NULL,
    causal_chain     TEXT NOT NULL DEFAULT '[]',
    related_lore_ids TEXT NOT NULL DEFAULT '[]',
    content_hash     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lore_hash ON lore(content_hash);
CREATE INDEX IF NOT EXISTS idx_lore_type ON lore(fact_type);
CREATE INDEX IF NOT EXISTS idx_lore_session_hash ON lore(session_id, content_hash);

-- Lore subjects (many-to-many)
CREATE TABLE IF NOT EXISTS lore_subjects (
    lore_id    TEXT NOT NULL REFERENCES lore(id),
    subject_id TEXT NOT NULL,
    PRIMARY KEY (lore_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_ls_subject ON lore_subjects(subject_id);

-- Injection queue
CREATE TABLE IF NOT EXISTS injections (
    id              TEXT PRIMARY KEY,
    injection_type  TEXT NOT NULL,
    voice_id        TEXT,
    content         TEXT NOT NULL,
    priority        TEXT,
    npc_id          TEXT,
    condition       TEXT,
    expiry_turns    INTEGER NOT NULL,
    created_at_turn INTEGER NOT NULL,
    consumed        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_inj_type ON injections(injection_type, consumed);
`

// ============================================================
// FTS5 virtual tables (trigram tokenizer for Chinese)
// ============================================================

const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    id, title, summary, narrative_text,
    content='events',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS npc_memories_fts USING fts5(
    npc_id, subjective_summary,
    content='npc_memories',
    content_rowid='id',
    tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
    npc_id, content,
    content='conversations',
    content_rowid='id',
    tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS lore_fts USING fts5(
    id, content,
    content='lore',
    content_rowid='rowid',
    tokenize='trigram'
);
`

// ============================================================
// FTS sync triggers
// ============================================================

const CREATE_FTS_TRIGGERS = `
-- Events FTS sync
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, id, title, summary, narrative_text)
    VALUES (new.rowid, new.id, new.title, new.summary, new.narrative_text);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, id, title, summary, narrative_text)
    VALUES ('delete', old.rowid, old.id, old.title, old.summary, old.narrative_text);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, id, title, summary, narrative_text)
    VALUES ('delete', old.rowid, old.id, old.title, old.summary, old.narrative_text);
    INSERT INTO events_fts(rowid, id, title, summary, narrative_text)
    VALUES (new.rowid, new.id, new.title, new.summary, new.narrative_text);
END;

-- NPC memories FTS sync
CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON npc_memories BEGIN
    INSERT INTO npc_memories_fts(rowid, npc_id, subjective_summary)
    VALUES (new.id, new.npc_id, new.subjective_summary);
END;

CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON npc_memories BEGIN
    INSERT INTO npc_memories_fts(npc_memories_fts, rowid, npc_id, subjective_summary)
    VALUES ('delete', old.id, old.npc_id, old.subjective_summary);
END;

-- Conversations FTS sync
CREATE TRIGGER IF NOT EXISTS conv_ai AFTER INSERT ON conversations BEGIN
    INSERT INTO conversations_fts(rowid, npc_id, content)
    VALUES (new.id, new.npc_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS conv_ad AFTER DELETE ON conversations BEGIN
    INSERT INTO conversations_fts(conversations_fts, rowid, npc_id, content)
    VALUES ('delete', old.id, old.npc_id, old.content);
END;

-- Lore FTS sync
CREATE TRIGGER IF NOT EXISTS lore_ai AFTER INSERT ON lore BEGIN
    INSERT INTO lore_fts(rowid, id, content)
    VALUES (new.rowid, new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS lore_ad AFTER DELETE ON lore BEGIN
    INSERT INTO lore_fts(lore_fts, rowid, id, content)
    VALUES ('delete', old.rowid, old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS lore_au AFTER UPDATE ON lore BEGIN
    INSERT INTO lore_fts(lore_fts, rowid, id, content)
    VALUES ('delete', old.rowid, old.id, old.content);
    INSERT INTO lore_fts(rowid, id, content)
    VALUES (new.rowid, new.id, new.content);
END;
`

// ============================================================
// Initialize database with schema
// ============================================================

export function initializeSchema(db: ISchemaDatabase): void {
  db.pragma?.('journal_mode = WAL')
  db.pragma?.('foreign_keys = ON')

  // Check current version
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  const currentVersion = row ? parseInt(row.value, 10) : 0

  if (currentVersion >= SCHEMA_VERSION) return

  db.exec(CREATE_TABLES)
  db.exec(CREATE_FTS)

  // Triggers must be executed one at a time — split on CREATE TRIGGER boundary
  for (const block of CREATE_FTS_TRIGGERS.split(/(?=CREATE TRIGGER)/)) {
    const trimmed = block.trim()
    if (trimmed) db.exec(trimmed)
  }

  if (currentVersion < 3) {
    try { db.exec("ALTER TABLE events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE npc_memories ADD COLUMN session_id TEXT NOT NULL DEFAULT ''") } catch {}
    try { db.exec("ALTER TABLE lore ADD COLUMN session_id TEXT NOT NULL DEFAULT ''") } catch {}

    db.exec('CREATE INDEX IF NOT EXISTS idx_events_session_turn ON events(session_id, turn)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_mem_session_npc ON npc_memories(session_id, npc_id, recorded_at_turn)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_lore_session_hash ON lore(session_id, content_hash)')

    // Old runtime data was not session-scoped. Drop it while preserving sessions,
    // genesis, save files, and per-session message history.
    db.exec('DELETE FROM event_participants')
    db.exec('DELETE FROM events')
    db.exec('DELETE FROM memory_participants')
    db.exec('DELETE FROM npc_memories')
    db.exec('DELETE FROM lore_subjects')
    db.exec('DELETE FROM lore')
    db.exec("DELETE FROM kv_store WHERE key NOT LIKE 'save:%' AND key NOT LIKE 'session:%'")
  }

  // Update version
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
}

/** Exported SQL for reuse in sql.js implementation */
export { CREATE_TABLES, CREATE_FTS, CREATE_FTS_TRIGGERS }
