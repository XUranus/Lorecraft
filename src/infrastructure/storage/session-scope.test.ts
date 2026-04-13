import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteStore } from './sqlite-store.js'
import type { Event } from '../../domain/models/event.js'
import type { LoreEntry } from '../../domain/models/lore.js'

function makeEvent(id: string, title: string): Event {
  return {
    id,
    title,
    timestamp: { day: 0, hour: 0, turn: 1 },
    location_id: 'dock',
    participant_ids: ['player'],
    tags: ['WORLD_CHANGE'],
    weight: 'MINOR',
    force_level: 0,
    created_at: 1,
    summary: title,
    choice_signals: {},
    context: title,
    related_event_ids: [],
    state_snapshot: { location_state: '', participant_states: {} },
    narrative_text: title,
  }
}

function makeLore(id: string, content: string): LoreEntry {
  return {
    id,
    content,
    fact_type: 'WORLD',
    authority_level: 'AI_CANONICALIZED',
    subject_ids: ['world'],
    source_event_id: null,
    created_at_turn: 1,
    causal_chain: [],
    related_lore_ids: [],
    content_hash: `hash_${id}`,
  }
}

describe('SQLiteStore session scoping', () => {
  let store: SQLiteStore

  beforeEach(() => {
    store = new SQLiteStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('isolates scoped state keys by session', async () => {
    const a = store.scopedStateStore('sess_a')
    const b = store.scopedStateStore('sess_b')

    await a.set('quests:graph', { quests: ['a'] })
    await b.set('quests:graph', { quests: ['b'] })

    expect(await a.get<{ quests: string[] }>('quests:graph')).toEqual({ quests: ['a'] })
    expect(await b.get<{ quests: string[] }>('quests:graph')).toEqual({ quests: ['b'] })
    expect(await store.stateStore.get('session:sess_a:quests:graph')).toEqual({ quests: ['a'] })
  })

  it('isolates scoped event queries by session', async () => {
    const a = store.scopedEventStore('sess_a')
    const b = store.scopedEventStore('sess_b')

    await a.append(makeEvent('evt_a', 'A event'))
    await b.append(makeEvent('evt_b', 'B event'))

    expect((await a.getAllTier1()).map((e) => e.id)).toEqual(['evt_a'])
    expect((await b.getAllTier1()).map((e) => e.id)).toEqual(['evt_b'])
    expect(await a.getTier1('evt_b')).toBeNull()
  })

  it('isolates scoped lore queries by session', async () => {
    const a = store.scopedLoreStore('sess_a')
    const b = store.scopedLoreStore('sess_b')

    await a.append(makeLore('lore_a', 'A lore'))
    await b.append(makeLore('lore_b', 'B lore'))

    expect((await a.findBySubject('world')).map((entry) => entry.id)).toEqual(['lore_a'])
    expect((await b.findBySubject('world')).map((entry) => entry.id)).toEqual(['lore_b'])
    expect(await a.findByContentHash('hash_lore_b')).toBeNull()
  })
})
