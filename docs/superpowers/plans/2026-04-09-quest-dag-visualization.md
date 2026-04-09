# Quest DAG Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the quest tab's sidebar + timeline with an interactive DAG canvas (pan/zoom, click-to-detail).

**Architecture:** Single SVG canvas with `<foreignObject>` nodes and bezier edges. Pure-code layered layout algorithm (simplified Sugiyama). Pan/zoom via CSS transform on SVG `<g>`. Fixed detail panel below canvas.

**Tech Stack:** React, SVG, CSS, no new dependencies.

---

### Task 1: DAG Layout Algorithm

Extract the layout logic as a pure function so it can be developed and verified independently of rendering.

**Files:**
- Create: `web/src/tabs/quest-dag-layout.ts`

- [ ] **Step 1: Create the layout module with types and constants**

```ts
// web/src/tabs/quest-dag-layout.ts
import type { QuestGraphForClient } from '../types/protocol'

type QNode = QuestGraphForClient['nodes'][number]
type QEdge = QuestGraphForClient['edges'][number]

export const NODE_W = 180
export const NODE_H = 48
export const LAYER_GAP = 80
export const NODE_GAP = 24

export interface PositionedNode extends QNode {
  x: number
  y: number
}

export interface PositionedEdge {
  from: { x: number; y: number }
  to: { x: number; y: number }
  cross_quest: boolean
}

export interface DagLayout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
}
```

- [ ] **Step 2: Implement `computeLayout`**

```ts
export function computeLayout(graph: QuestGraphForClient): DagLayout {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] }

  // --- Step 1: Build adjacency ---
  const inEdges = new Map<string, string[]>()   // nodeId -> [parent ids]
  const outEdges = new Map<string, string[]>()   // nodeId -> [child ids]
  for (const n of graph.nodes) {
    inEdges.set(n.id, [])
    outEdges.set(n.id, [])
  }
  const nodeSet = new Set(graph.nodes.map(n => n.id))
  for (const e of graph.edges) {
    if (!nodeSet.has(e.from_node_id) || !nodeSet.has(e.to_node_id)) continue
    inEdges.get(e.to_node_id)!.push(e.from_node_id)
    outEdges.get(e.from_node_id)!.push(e.to_node_id)
  }

  // --- Step 2: Topological layering ---
  const layerOf = new Map<string, number>()
  const visited = new Set<string>()

  function assignLayer(id: string): number {
    if (layerOf.has(id)) return layerOf.get(id)!
    if (visited.has(id)) return 0  // cycle guard
    visited.add(id)
    const parents = inEdges.get(id) ?? []
    const layer = parents.length === 0 ? 0 : Math.max(...parents.map(assignLayer)) + 1
    layerOf.set(id, layer)
    return layer
  }

  for (const n of graph.nodes) assignLayer(n.id)

  // Orphan nodes (no edges at all) → push to max layer + 1, grouped by quest
  const maxLayer = Math.max(0, ...layerOf.values())
  for (const n of graph.nodes) {
    const hasAny = (inEdges.get(n.id)?.length ?? 0) > 0 || (outEdges.get(n.id)?.length ?? 0) > 0
    if (!hasAny && graph.nodes.length > 1) {
      // Only push orphans down if there are non-orphan nodes
      layerOf.set(n.id, maxLayer + 1)
    }
  }

  // --- Step 3: Group by layer and sort intra-layer ---
  const layers = new Map<number, typeof graph.nodes>()
  for (const n of graph.nodes) {
    const l = layerOf.get(n.id)!
    if (!layers.has(l)) layers.set(l, [])
    layers.get(l)!.push(n)
  }
  for (const [, arr] of layers) {
    arr.sort((a, b) => a.quest_id.localeCompare(b.quest_id) || a.turn - b.turn)
  }

  // --- Step 4: Assign coordinates ---
  const positioned: PositionedNode[] = []
  const nodePos = new Map<string, { x: number; y: number }>()

  const sortedLayerKeys = [...layers.keys()].sort((a, b) => a - b)
  for (const layerIdx of sortedLayerKeys) {
    const arr = layers.get(layerIdx)!
    const count = arr.length
    const totalW = count * NODE_W + (count - 1) * NODE_GAP
    const startX = -totalW / 2
    const y = layerIdx * (NODE_H + LAYER_GAP)
    for (let i = 0; i < count; i++) {
      const x = startX + i * (NODE_W + NODE_GAP)
      const pn: PositionedNode = { ...arr[i], x, y }
      positioned.push(pn)
      nodePos.set(arr[i].id, { x, y })
    }
  }

  // --- Step 5: Compute edges ---
  const questOf = new Map(graph.nodes.map(n => [n.id, n.quest_id]))
  const posEdges: PositionedEdge[] = []
  for (const e of graph.edges) {
    const fp = nodePos.get(e.from_node_id)
    const tp = nodePos.get(e.to_node_id)
    if (!fp || !tp) continue
    posEdges.push({
      from: { x: fp.x + NODE_W / 2, y: fp.y + NODE_H },
      to: { x: tp.x + NODE_W / 2, y: tp.y },
      cross_quest: questOf.get(e.from_node_id) !== questOf.get(e.to_node_id),
    })
  }

  return { nodes: positioned, edges: posEdges }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /home/thankod/crpg/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add web/src/tabs/quest-dag-layout.ts
git commit -m "feat(quest): add DAG layout algorithm"
```

---

### Task 2: Quest Color Palette Utility

A small helper to assign a consistent color to each quest ID.

**Files:**
- Create: `web/src/tabs/quest-colors.ts`

- [ ] **Step 1: Create the color palette module**

```ts
// web/src/tabs/quest-colors.ts

const PALETTE = [
  '#c4956a', // amber
  '#5aafa0', // teal
  '#c47a8a', // rose
  '#9a7abf', // violet
  '#6a8ab8', // slate-blue
  '#8a9a5a', // olive
  '#c47a5a', // coral
  '#5aafbf', // cyan
]

const cache = new Map<string, string>()
let nextIdx = 0

export function questColor(questId: string): string {
  let c = cache.get(questId)
  if (!c) {
    c = PALETTE[nextIdx % PALETTE.length]
    cache.set(questId, c)
    nextIdx++
  }
  return c
}

/** Reset cache — call when game resets */
export function resetQuestColors(): void {
  cache.clear()
  nextIdx = 0
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/thankod/crpg/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add web/src/tabs/quest-colors.ts
git commit -m "feat(quest): add quest color palette utility"
```

---

### Task 3: QuestTab.css Full Rewrite

Replace the sidebar + timeline styles with DAG canvas + detail panel styles.

**Files:**
- Modify: `web/src/tabs/QuestTab.css` (full rewrite)

- [ ] **Step 1: Write new QuestTab.css**

```css
/* web/src/tabs/QuestTab.css */

.quest-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── DAG Canvas Container ── */
.quest-canvas-wrap {
  flex: 1;
  overflow: hidden;
  position: relative;
  cursor: grab;
}

.quest-canvas-wrap.grabbing {
  cursor: grabbing;
}

.quest-canvas-wrap svg {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── Edges ── */
.quest-edge {
  fill: none;
  stroke: #2a2828;
  stroke-width: 1.5;
}

.quest-edge.cross {
  stroke-dasharray: 6 4;
}

.quest-edge-arrow {
  fill: #2a2828;
}

/* ── Nodes (foreignObject content) ── */
.quest-dag-node {
  width: 180px;
  height: 48px;
  border-radius: var(--radius-md);
  border: 1.5px solid var(--border);
  display: flex;
  align-items: center;
  gap: 0;
  cursor: pointer;
  transition: box-shadow var(--duration-fast), border-color var(--duration-fast);
  overflow: hidden;
  user-select: none;
}

.quest-dag-node:hover {
  border-color: var(--fg-muted);
}

/* Quest color bar (left edge) */
.quest-dag-node-bar {
  width: 4px;
  align-self: stretch;
  flex-shrink: 0;
}

/* Node text */
.quest-dag-node-label {
  flex: 1;
  padding: 4px 10px;
  font-family: var(--font-ui);
  font-size: 12px;
  line-height: 1.4;
  color: var(--fg);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* Status variants */
.quest-dag-node.s-completed {
  background: rgba(100, 180, 100, 0.12);
  border-color: #7cb87c;
}

.quest-dag-node.s-active {
  background: rgba(196, 149, 106, 0.10);
  border-color: var(--title);
}

.quest-dag-node.s-active .quest-dag-node-label {
  font-style: italic;
  color: var(--fg-muted);
}

.quest-dag-node.s-failed {
  background: rgba(180, 80, 80, 0.12);
  border-color: #b85c5c;
}

.quest-dag-node.s-failed .quest-dag-node-label {
  text-decoration: line-through;
  color: var(--fg-muted);
}

/* Selected glow */
.quest-dag-node.selected {
  box-shadow: 0 0 12px rgba(196, 149, 106, 0.3);
}

/* ── Detail Panel ── */
.quest-detail {
  height: 120px;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  padding: 12px var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.quest-detail-empty {
  height: 120px;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  font-size: 13px;
  font-family: var(--font-ui);
}

.quest-detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quest-detail-bar {
  width: 4px;
  height: 16px;
  border-radius: 2px;
  flex-shrink: 0;
}

.quest-detail-quest-title {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
  letter-spacing: 0.3px;
}

.quest-detail-summary {
  font-family: var(--font-narrative);
  font-size: 14px;
  color: var(--fg);
  line-height: 1.6;
  margin: 0;
}

.quest-detail-hint {
  font-family: var(--font-narrative);
  font-size: 13px;
  color: var(--fg-muted);
  font-style: italic;
  margin: 0;
}

.quest-detail-turn {
  font-family: var(--font-ui);
  font-size: 10px;
  color: var(--fg-muted);
  text-align: right;
  margin-top: auto;
}

/* ── Empty state (no quests at all) ── */
.quest-tab-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  font-size: 13px;
  font-family: var(--font-ui);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/tabs/QuestTab.css
git commit -m "feat(quest): rewrite QuestTab CSS for DAG canvas layout"
```

---

### Task 4: QuestTab.tsx Full Rewrite — Canvas, Nodes, Edges, Pan/Zoom, Detail Panel

Replace the entire component with the DAG visualization.

**Files:**
- Modify: `web/src/tabs/QuestTab.tsx` (full rewrite)

- [ ] **Step 1: Write the new QuestTab.tsx**

```tsx
// web/src/tabs/QuestTab.tsx
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/thankod/crpg/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Verify build succeeds**

Run: `cd /home/thankod/crpg/web && pnpm build`
Expected: build completes without errors

- [ ] **Step 4: Commit**

```bash
git add web/src/tabs/QuestTab.tsx
git commit -m "feat(quest): rewrite QuestTab as interactive DAG visualization"
```

---

### Task 5: Generate Visual Preview HTML

Generate a standalone HTML file in the user's home directory with mock quest data so they can download and preview the DAG look & feel without running the dev server.

**Files:**
- Create: `/home/thankod/quest-dag-preview.html`

- [ ] **Step 1: Write the preview HTML**

A single self-contained HTML file that inlines the CSS variables, QuestTab.css styles, and renders a mock DAG with 3 quests, ~8 nodes, and several edges (including a cross-quest edge). Implements the same pan/zoom/click-to-detail logic in vanilla JS so the user can interact with it.

Mock data:
- Quest "investigate_caravan": 3 nodes (completed → completed → active)
- Quest "north_gate_mystery": 2 nodes (completed → active)
- Quest "tavern_debt": 2 nodes (completed → failed)
- Cross-quest edge from investigate_caravan node 2 → north_gate_mystery node 1
- One orphan active node on a new quest

- [ ] **Step 2: Commit**

```bash
git add /home/thankod/quest-dag-preview.html
# Don't commit — this is a preview file outside the repo
```

Actually, this file is outside the repo. No commit needed. Just notify the user it's ready to download.

---

### Task 6: Build Verification & Cleanup

Final check that everything compiles and builds correctly.

**Files:**
- None (verification only)

- [ ] **Step 1: Full TypeScript check**

Run: `cd /home/thankod/crpg/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Full production build**

Run: `cd /home/thankod/crpg/web && pnpm build`
Expected: build completes without errors

- [ ] **Step 3: Final commit with all files**

```bash
git add -A
git status
git commit -m "feat(quest): complete DAG visualization rewrite"
```
