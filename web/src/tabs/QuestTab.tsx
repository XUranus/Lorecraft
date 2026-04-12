import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import { registerTab } from './registry'
import { computeLayout, NODE_W, NODE_H } from './quest-dag-layout'
import type { PositionedNode } from './quest-dag-layout'
import { questColor, resetQuestColors } from './quest-colors'
import './QuestTab.css'

const ZOOM_MIN = 0.3
const ZOOM_MAX = 2
const ZOOM_STEP = 0.15

function QuestTab() {
  const t = useT()
  const send = useGameStore((s) => s.send)
  const questGraph = useGameStore((s) => s.questGraph)
  const turn = useGameStore((s) => s.turn)

  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Pan / zoom state
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)

  // Drag state (refs to avoid re-render during drag)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })
  const didMove = useRef(false)

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

  // Auto-center on first layout or when node count changes
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!layout || !wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    setPan({ x: rect.width / 2, y: 40 })
    setZoom(1)
  }, [layout?.nodes.length])

  // Selected node lookup
  const selectedNode = useMemo(() => {
    if (!selectedId || !layout) return null
    return layout.nodes.find(n => n.id === selectedId) ?? null
  }, [selectedId, layout])

  // ── Touch pan (single finger) ──
  const onTouchStartPan = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    dragging.current = true
    didMove.current = false
    dragStart.current = { x: t.clientX, y: t.clientY }
    panStart.current = { ...pan }
  }, [pan])

  const onTouchMovePan = useCallback((e: React.TouchEvent) => {
    if (!dragging.current || e.touches.length !== 1) return
    e.preventDefault()
    const t = e.touches[0]
    didMove.current = true
    setPan({
      x: panStart.current.x + (t.clientX - dragStart.current.x),
      y: panStart.current.y + (t.clientY - dragStart.current.y),
    })
  }, [])

  const onTouchEndPan = useCallback(() => {
    dragging.current = false
  }, [])

  // ── Mouse pan (desktop) ──
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-node-id]')) return
    dragging.current = true
    didMove.current = false
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
  }, [pan])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    didMove.current = true
    setPan({
      x: panStart.current.x + (e.clientX - dragStart.current.x),
      y: panStart.current.y + (e.clientY - dragStart.current.y),
    })
  }, [])

  const onMouseUp = useCallback(() => {
    dragging.current = false
  }, [])

  // ── Wheel zoom (desktop) ──
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor))
    const ratio = newZoom / zoom

    setPan(prev => ({
      x: mx - ratio * (mx - prev.x),
      y: my - ratio * (my - prev.y),
    }))
    setZoom(newZoom)
  }, [zoom])

  // ── Zoom controls (UI buttons) ──
  const zoomIn = useCallback(() => {
    setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP))
  }, [])

  const zoomOut = useCallback(() => {
    setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP))
  }, [])

  const onZoomSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setZoom(parseFloat(e.target.value))
  }, [])

  // ── Node click ──
  const onNodeClick = useCallback((nodeId: string) => {
    setSelectedId(prev => prev === nodeId ? null : nodeId)
  }, [])

  // ── Click on empty space → deselect (only if didn't drag) ──
  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    if (didMove.current) return
    if (!(e.target as HTMLElement).closest('[data-node-id]')) {
      setSelectedId(null)
    }
  }, [])

  // ── Empty state ──
  if (!questGraph || !layout) {
    return (
      <div className="quest-tab">
        <div className="quest-tab-empty">{t('quest.emptyHint')}</div>
      </div>
    )
  }

  return (
    <div className="quest-tab">
      <div
        ref={wrapRef}
        className={`quest-canvas-wrap ${dragging.current ? 'grabbing' : ''}`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
        onTouchStart={onTouchStartPan}
        onTouchMove={onTouchMovePan}
        onTouchEnd={onTouchEndPan}
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
        {/* Zoom controls */}
        <div className="quest-zoom-controls">
          <button className="quest-zoom-btn" onClick={zoomIn} aria-label={t('quest.zoomIn')}>+</button>
          <input
            className="quest-zoom-slider"
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.05}
            value={zoom}
            onChange={onZoomSlider}
          />
          <button className="quest-zoom-btn" onClick={zoomOut} aria-label={t('quest.zoomOut')}>&minus;</button>
          <span className="quest-zoom-label">{Math.round(zoom * 100)}%</span>
        </div>
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
  const t = useT()

  if (!node) {
    return <div className="quest-detail-empty">{t('quest.selectHint')}</div>
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
        <p className="quest-detail-hint">{t('quest.hint', { hint: node.hint })}</p>
      )}
      <div className="quest-detail-turn">{t('quest.turn', { turn: node.turn })}</div>
    </div>
  )
}

registerTab({
  id: 'quests',
  labelKey: 'tab.quests',
  component: QuestTab,
})
