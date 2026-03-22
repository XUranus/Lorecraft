import type { LocationEdge } from '../models/world.js'
import type { ReachabilityResult } from '../models/pipeline-io.js'

/** Context needed to evaluate traversal conditions during pathfinding. */
export interface TraversalContext {
  playerHasKey: (key: string) => boolean
  eventHasOccurred: (eventId: string) => boolean
}

interface AdjEntry {
  neighborId: string
  edge: LocationEdge
}

export class LocationGraph {
  private readonly adjacency: Map<string, AdjEntry[]> = new Map()

  constructor(edges: LocationEdge[]) {
    for (const edge of edges) {
      this.insertEdge(edge)
    }
  }

  /**
   * Determines whether `to` is reachable from `from` using BFS shortest path.
   * Evaluates traversal conditions (REQUIRES_KEY, REQUIRES_EVENT, BLOCKED) at
   * each edge. Returns total travel turns on success, or a reason string on failure.
   */
  isReachable(from: string, to: string, context: TraversalContext): ReachabilityResult {
    if (from === to) {
      return { reachable: true, total_travel_turns: 0 }
    }

    const visited = new Set<string>()
    // BFS queue: [locationId, accumulated travel turns]
    const queue: Array<[string, number]> = [[from, 0]]
    visited.add(from)

    while (queue.length > 0) {
      const [current, costSoFar] = queue.shift()!
      const neighbors = this.adjacency.get(current)
      if (!neighbors) continue

      for (const { neighborId, edge } of neighbors) {
        if (visited.has(neighborId)) continue

        if (!this.canTraverse(edge, context)) continue

        const newCost = costSoFar + edge.travel_time_turns
        if (neighborId === to) {
          return { reachable: true, total_travel_turns: newCost }
        }

        visited.add(neighborId)
        queue.push([neighborId, newCost])
      }
    }

    return { reachable: false, reason: `No traversable path from "${from}" to "${to}"` }
  }

  /**
   * Returns all adjacent location IDs for the given location.
   */
  getNeighbors(location_id: string): string[] {
    const entries = this.adjacency.get(location_id)
    if (!entries) return []
    return entries.map((e) => e.neighborId)
  }

  /**
   * Adds a new edge to the graph at runtime. The edge is undirected:
   * connections are created in both directions.
   */
  addEdge(edge: LocationEdge): void {
    this.insertEdge(edge)
  }

  /**
   * Updates properties of an existing edge between two locations.
   * Updates both directions of the undirected edge.
   */
  updateEdge(
    from: string,
    to: string,
    updates: Partial<Pick<LocationEdge, 'traversal_condition' | 'condition_detail' | 'travel_time_turns'>>,
  ): void {
    this.applyEdgeUpdate(from, to, updates)
    this.applyEdgeUpdate(to, from, updates)
  }

  // ── Internal ──────────────────────────────────────────────

  private insertEdge(edge: LocationEdge): void {
    this.addDirectedEntry(edge.from_location_id, edge.to_location_id, edge)

    const reverseEdge: LocationEdge = {
      ...edge,
      from_location_id: edge.to_location_id,
      to_location_id: edge.from_location_id,
    }
    this.addDirectedEntry(edge.to_location_id, edge.from_location_id, reverseEdge)
  }

  private addDirectedEntry(from: string, to: string, edge: LocationEdge): void {
    let entries = this.adjacency.get(from)
    if (!entries) {
      entries = []
      this.adjacency.set(from, entries)
    }

    // Avoid duplicate directed entries for the same neighbor
    const existing = entries.find((e) => e.neighborId === to)
    if (!existing) {
      entries.push({ neighborId: to, edge })
    } else {
      existing.edge = edge
    }
  }

  private applyEdgeUpdate(
    from: string,
    to: string,
    updates: Partial<Pick<LocationEdge, 'traversal_condition' | 'condition_detail' | 'travel_time_turns'>>,
  ): void {
    const entries = this.adjacency.get(from)
    if (!entries) return

    const entry = entries.find((e) => e.neighborId === to)
    if (!entry) return

    entry.edge = { ...entry.edge, ...updates }
  }

  private canTraverse(edge: LocationEdge, context: TraversalContext): boolean {
    switch (edge.traversal_condition) {
      case 'OPEN':
        return true
      case 'BLOCKED':
        return false
      case 'REQUIRES_KEY':
        return edge.condition_detail != null && context.playerHasKey(edge.condition_detail)
      case 'REQUIRES_EVENT':
        return edge.condition_detail != null && context.eventHasOccurred(edge.condition_detail)
      default:
        return false
    }
  }
}
