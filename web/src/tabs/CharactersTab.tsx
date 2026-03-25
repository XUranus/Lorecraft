import { useState, useEffect } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { registerTab } from './registry'
import type { CharacterInfo } from '../types/protocol'
import './CharactersTab.css'

function CharactersTab() {
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
            <span className="char-sidebar-tag player">玩家</span>
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
          <div className="char-sidebar-empty">加载中…</div>
        )}
      </div>

      <div className="char-detail">
        {selected ? (
          <>
            <h2 className="char-detail-name">{selected.name}</h2>

            {/* Player: background + attributes */}
            {isPlayer && selected.background && (
              <section className="char-section">
                <h3>背景</h3>
                <p>{selected.background}</p>
              </section>
            )}

            {isPlayer && selected.attributes && (
              <section className="char-section">
                <h3>属性</h3>
                <div className="char-attrs">
                  {Object.entries(selected.attributes).map(([key, val]) => (
                    <div key={key} className="char-attr-row">
                      <span className="char-attr-name">{key}</span>
                      <div className="char-attr-bar-bg">
                        <div className="char-attr-bar" style={{ width: `${val}%` }} />
                      </div>
                      <span className="char-attr-val">{val}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* NPC: knowledge-based display */}
            {!isPlayer && (() => {
              const hasContent = selected.first_impression || selected.relationship_to_player || (selected.known_facts && selected.known_facts.length > 0)
              if (!hasContent) {
                return <p className="char-no-info">尚未深入了解此人。</p>
              }
              return (
                <>
                  {selected.first_impression && (
                    <section className="char-section">
                      <h3>印象</h3>
                      <p>{selected.first_impression}</p>
                    </section>
                  )}

                  {selected.relationship_to_player && (
                    <section className="char-section">
                      <h3>与你的关系</h3>
                      <p>{selected.relationship_to_player}</p>
                    </section>
                  )}

                  {selected.known_facts && selected.known_facts.length > 0 && (
                    <section className="char-section">
                      <h3>已知信息</h3>
                      <ul className="char-known-facts">
                        {selected.known_facts.map((fact, i) => (
                          <li key={i}>{fact}</li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {selected.last_seen_location && (
                    <section className="char-section">
                      <h3>最后见面</h3>
                      <div className="char-last-seen">
                        <span>地点：{selected.last_seen_location}</span>
                        {selected.last_interaction_turn != null && selected.last_interaction_turn > 0 && (
                          <span>第 {selected.last_interaction_turn} 回合</span>
                        )}
                      </div>
                    </section>
                  )}
                </>
              )
            })()}
          </>
        ) : (
          <div className="char-detail-empty">选择一个角色</div>
        )}
      </div>
    </div>
  )
}

registerTab({ id: 'characters', label: '人物', component: CharactersTab })
