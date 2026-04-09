import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { registerTab } from './registry'
import { computeLayout, NODE_W, NODE_H } from './quest-dag-layout'
import type { PositionedNode } from './quest-dag-layout'
import { questColor, resetQuestColors } from './quest-colors'
import './QuestTab.css'

function QuestTab() {
  const send = useGameStore((s) => s.send)
  const questGraph = useGameStore((s) => s.questGraph)
  const turn = useGameStore((s) => s.turn)

  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Pan / zoom state
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  // Refresh quest data on turn change
  useEffect(() => {
    send({ type: 'get_quests' })
  }, [turn, send])

  // Reset colors and view when graph becomes null (new game)
  useEffect(() => {
    if (!questGraph) {
      resetQuestColors()
      setPan({ x: 0, y: 0 })
      setZoom(1)
      setSelectedId(null)
    }
  }, [questGraph])

  // Layout computation
  const layout = useMemo(() => {
    if (!questGraph || questGraph.nodes.length === 0) return null
    return computeLayout(questGraph)
  }, [questGraph])

  // Auto-center on first layout or when layout changes significantly
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!layout || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    // Center the graph in the viewport
    setPan({ x: rect.width / 2, y: 40 })
    setZoom(1)
  }, [layout?.nodes.length])

  // Selected node lookup
  const selectedNode = useMemo(() => {
    if (!selectedId || !layout) return null
    return layout.nodes.find(n => n.id === selectedId) ?? null
  }, [selectedId, layout])

  // ── Pan handlers ──
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only pan on left button, and not on a node
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-node-id]')) return
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [pan])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    setPan({
      x: panStart.current.x + (e.clientX - dragStart.current.x),
      y: panStart.current.y + (e.clientY - dragStart.current.y),
    })
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  // ── Zoom handler ──
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const newZoom = Math.min(2, Math.max(0.3, zoom * factor))
    const ratio = newZoom / zoom

    // Adjust pan so zoom centers on mouse position
    setPan(prev => ({
      x: mx - ratio * (mx - prev.x),
      y: my - ratio * (my - prev.y),
    }))
    setZoom(newZoom)
  }, [zoom])

  // ── Node click ──
  const onNodeClick = useCallback((nodeId: string) => {
    setSelectedId(prev => prev === nodeId ? null : nodeId)
  }, [])

  // ── Click on empty space → deselect ──
  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.closest('[data-node-id]')) {
      setSelectedId(null)
    }
  }, [])

  // ── Empty state ──
  if (!questGraph || !layout) {
    return (
      <div className="quest-tab">
        <div className="quest-tab-empty">任务将在冒险过程中出现</div>
      </div>
    )
  }

  return (
    <div className="quest-tab">
      <div
        ref={wrapRef}
        className={`quest-canvas-wrap ${dragging.current ? 'grabbing' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onClick={onCanvasClick}
      >
        <svg>
          <defs>
            <marker
              id="arrowhead"
              markerWidth="8"
              markerHeight="6"
              refX="8"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" className="quest-edge-arrow" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {/* Edges */}
            {layout.edges.map((edge, i) => {
              const midY = (edge.from.y + edge.to.y) / 2
              const d = `M ${edge.from.x} ${edge.from.y} Q ${edge.from.x} ${midY}, ${edge.to.x} ${edge.to.y}`
              return (
                <path
                  key={i}
                  d={d}
                  className={`quest-edge ${edge.cross_quest ? 'cross' : ''}`}
                  markerEnd="url(#arrowhead)"
                />
              )
            })}
            {/* Nodes */}
            {layout.nodes.map(node => (
              <foreignObject
                key={node.id}
                x={node.x}
                y={node.y}
                width={NODE_W}
                height={NODE_H}
                data-node-id={node.id}
              >
                <div
                  className={`quest-dag-node s-${node.status} ${node.id === selectedId ? 'selected' : ''}`}
                  data-node-id={node.id}
                  onClick={(e) => { e.stopPropagation(); onNodeClick(node.id) }}
                >
                  <div className="quest-dag-node-bar" style={{ background: questColor(node.quest_id) }} />
                  <span className="quest-dag-node-label">
                    {node.status === 'active' ? node.hint : node.summary}
                  </span>
                </div>
              </foreignObject>
            ))}
          </g>
        </svg>
      </div>
      <DetailPanel node={selectedNode} quests={questGraph.quests} />
    </div>
  )
}

function DetailPanel({
  node,
  quests,
}: {
  node: PositionedNode | null
  quests: Array<{ id: string; title: string; status: string }>
}) {
  if (!node) {
    return <div className="quest-detail-empty">点击节点查看详情</div>
  }

  const quest = quests.find(q => q.id === node.quest_id)
  const color = questColor(node.quest_id)

  return (
    <div className="quest-detail">
      <div className="quest-detail-header">
        <div className="quest-detail-bar" style={{ background: color }} />
        <span className="quest-detail-quest-title">{quest?.title ?? node.quest_id}</span>
      </div>
      <p className="quest-detail-summary">{node.summary}</p>
      {node.status === 'active' && node.hint && (
        <p className="quest-detail-hint">提示：{node.hint}</p>
      )}
      <div className="quest-detail-turn">回合 {node.turn}</div>
    </div>
  )
}

registerTab({
  id: 'quests',
  label: '任务',
  icon: '\uD83D\uDCDC',
  component: QuestTab,
})
