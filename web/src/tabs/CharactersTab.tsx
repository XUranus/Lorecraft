import { useState, useEffect } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import { registerTab } from './registry'
import type { CharacterInfo } from '../types/protocol'
import './CharactersTab.css'

function attrTierColor(val: number): string {
  if (val > 90) return 'var(--title)'       // tier-4: accent
  if (val > 60) return 'var(--system)'      // tier-3: system
  if (val > 30) return 'var(--fg-muted)'    // tier-2: muted
  if (val > 10) return 'var(--tier-1)'      // tier-1
  return 'var(--tier-0)'                    // tier-0
}

function CharactersTab() {
  const t = useT()
  const send = useGameStore((s) => s.send)
  const playerInfo = useGameStore((s) => s.playerInfo)
  const npcList = useGameStore((s) => s.npcList)
  const turn = useGameStore((s) => s.turn)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Refresh character data when tab is viewed or turn changes
  useEffect(() => {
    send({ type: 'get_characters' })
  }, [turn, send])

  // Auto-select player if nothing selected
  const selected: CharacterInfo | null =
    selectedId
      ? (selectedId === playerInfo?.id ? playerInfo : npcList.find((n) => n.id === selectedId) ?? null)
      : playerInfo

  const isPlayer = selected?.id === playerInfo?.id

  return (
    <div className="characters-tab">
      <div className="char-sidebar">
        {playerInfo && (
          <button
            className={`char-sidebar-item ${(!selectedId || selectedId === playerInfo.id) ? 'active' : ''}`}
            onClick={() => setSelectedId(playerInfo.id)}
          >
            <span className="char-sidebar-name">{playerInfo.name}</span>
            <span className="char-sidebar-tag player">{t('characters.player')}</span>
          </button>
        )}
        {npcList.map((npc) => (
          <button
            key={npc.id}
            className={`char-sidebar-item ${selectedId === npc.id ? 'active' : ''}`}
            onClick={() => setSelectedId(npc.id)}
          >
            <span className="char-sidebar-name">{npc.name}</span>
          </button>
        ))}
        {!playerInfo && npcList.length === 0 && (
          <div className="char-sidebar-empty">{t('characters.loading')}</div>
        )}
      </div>

      <div className="char-detail">
        {selected ? (
          <>
            <h2 className="char-detail-name">{selected.name}</h2>

            {/* Player: background + attributes */}
            {isPlayer && selected.background && (
              <section className="char-section">
                <h3>{t('characters.background')}</h3>
                <p>{selected.background}</p>
              </section>
            )}

            {isPlayer && selected.attributes && (
              <section className="char-section">
                <h3>{t('characters.attributes')}</h3>
                <div className="char-attrs">
                  {Object.entries(selected.attributes).map(([key, val]) => {
                    const color = attrTierColor(val as number)
                    return (
                      <div key={key} className="char-attr-row">
                        <span className="char-attr-name">{t(`attrName.${key}`)}</span>
                        <div className="char-attr-bar-bg">
                          <div className="char-attr-bar" style={{ width: `${val}%`, background: color }} />
                        </div>
                        <span className="char-attr-val" style={{ color }}>{val}</span>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {/* NPC: knowledge-based display */}
            {!isPlayer && (() => {
              const hasContent = selected.first_impression || selected.relationship_to_player || (selected.known_facts && selected.known_facts.length > 0)
              if (!hasContent) {
                return <p className="char-no-info">{t('characters.noInfo')}</p>
              }
              return (
                <>
                  {selected.first_impression && (
                    <section className="char-section">
                      <h3>{t('characters.impression')}</h3>
                      <p>{selected.first_impression}</p>
                    </section>
                  )}

                  {selected.relationship_to_player && (
                    <section className="char-section">
                      <h3>{t('characters.relationship')}</h3>
                      <p>{selected.relationship_to_player}</p>
                    </section>
                  )}

                  {selected.known_facts && selected.known_facts.length > 0 && (
                    <section className="char-section">
                      <h3>{t('characters.knownFacts')}</h3>
                      <ul className="char-known-facts">
                        {selected.known_facts.map((fact, i) => (
                          <li key={i}>{fact}</li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {selected.last_seen_location && (
                    <section className="char-section">
                      <h3>{t('characters.lastSeen')}</h3>
                      <div className="char-last-seen">
                        <span>{t('characters.lastSeenLocation', { location: selected.last_seen_location })}</span>
                        {selected.last_interaction_turn != null && selected.last_interaction_turn > 0 && (
                          <span>{t('characters.lastSeenTurn', { turn: selected.last_interaction_turn })}</span>
                        )}
                      </div>
                    </section>
                  )}
                </>
              )
            })()}
          </>
        ) : (
          <div className="char-detail-empty">{t('characters.selectHint')}</div>
        )}
      </div>
    </div>
  )
}

registerTab({ id: 'characters', labelKey: 'tab.characters', component: CharactersTab })
