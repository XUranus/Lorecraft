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

export function computeLayout(graph: QuestGraphForClient): DagLayout {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] }

  const inEdges = new Map<string, string[]>()
  const outEdges = new Map<string, string[]>()
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

  const layerOf = new Map<string, number>()
  const visited = new Set<string>()

  function assignLayer(id: string): number {
    if (layerOf.has(id)) return layerOf.get(id)!
    if (visited.has(id)) return 0
    visited.add(id)
    const parents = inEdges.get(id) ?? []
    const layer = parents.length === 0 ? 0 : Math.max(...parents.map(assignLayer)) + 1
    layerOf.set(id, layer)
    return layer
  }

  for (const n of graph.nodes) assignLayer(n.id)

  const maxLayer = Math.max(0, ...layerOf.values())
  for (const n of graph.nodes) {
    const hasAny = (inEdges.get(n.id)?.length ?? 0) > 0 || (outEdges.get(n.id)?.length ?? 0) > 0
    if (!hasAny && graph.nodes.length > 1) {
      layerOf.set(n.id, maxLayer + 1)
    }
  }

  const layers = new Map<number, typeof graph.nodes>()
  for (const n of graph.nodes) {
    const l = layerOf.get(n.id)!
    if (!layers.has(l)) layers.set(l, [])
    layers.get(l)!.push(n)
  }
  for (const [, arr] of layers) {
    arr.sort((a, b) => a.quest_id.localeCompare(b.quest_id) || a.turn - b.turn)
  }

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
