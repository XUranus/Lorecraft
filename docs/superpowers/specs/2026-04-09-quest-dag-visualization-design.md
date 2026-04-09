# Quest DAG Visualization Design

## Overview

Replace the current quest tab (left sidebar + vertical timeline) with a single interactive DAG (directed acyclic graph) visualization. All quests and their nodes render on one canvas. Users pan/zoom the canvas and click nodes to see details in a fixed bottom panel.

## Layout

```
┌─────────────────────────────────┐
│                                 │
│   [pannable/zoomable DAG canvas]│
│                                 │
│     ●──→●──→◐                  │
│          ↘                      │
│           ●──→●                │
│                                 │
├─────────────────────────────────┤
│  Detail panel (selected node)   │
│  quest title / summary / hint   │
└─────────────────────────────────┘
```

- **Canvas area**: fills the tab minus the detail panel height. Pure SVG inside a div with CSS `transform` for pan/zoom.
- **Detail panel**: fixed at bottom, ~120px height, does not participate in pan/zoom.
- **No sidebar**: the left quest list sidebar is removed entirely.

## Node Rendering

Each node is an SVG `<foreignObject>` containing an HTML div (for text wrapping and CSS styling), displayed as a rounded rectangle with a one-sentence summary (10-20 chars).

### Status Colors

| Status | Background | Border | Text |
|--------|-----------|--------|------|
| completed | `rgba(100,180,100,0.12)` | `#7cb87c` | summary, normal color |
| active | `rgba(196,149,106,0.10)` | `var(--title)` #c4956a | hint, italic |
| failed | `rgba(180,80,80,0.12)` | `#b85c5c` | summary, line-through |

### Quest Differentiation

Each Quest is assigned a **left color bar** (4px wide) from a preset palette. The palette cycles through 6-8 distinguishable hues. This lets the user visually group nodes belonging to the same quest without needing a separate legend.

Palette (approximate): amber, teal, rose, violet, slate-blue, olive, coral, cyan.

### Selected State

Clicked node gets a subtle glow (`box-shadow`) matching its quest color, and the border brightens. Only one node can be selected at a time.

## Edge Rendering

- **Same-quest edges**: solid SVG `<path>` with quadratic bezier curves, color `var(--border)` or slightly brighter.
- **Cross-quest edges**: dashed lines (`stroke-dasharray: 6 4`), same bezier style.
- Edges go from source node bottom-center to target node top-center.
- Optional arrowhead via SVG `<marker>`.

## DAG Layout Algorithm

Layered layout (simplified Sugiyama), implemented in code without external libraries:

### Step 1: Topological Layering

Assign each node a `layer` value:
- Nodes with no incoming edges → layer 0
- Other nodes → `max(layer of all parents) + 1`
- Orphan nodes (no edges at all) → assigned to a virtual "bottom" layer, grouped by quest

### Step 2: Intra-Layer Ordering

Within each layer, sort nodes by:
1. Quest ID (group same-quest nodes together)
2. Turn number (earlier turns first within same quest)

### Step 3: Coordinate Calculation

```
NODE_WIDTH = 180
NODE_HEIGHT = 48
LAYER_GAP_Y = 80    // vertical gap between layers
NODE_GAP_X = 24     // horizontal gap between nodes in same layer

For each layer:
  totalWidth = count * NODE_WIDTH + (count - 1) * NODE_GAP_X
  startX = -totalWidth / 2  // center around origin
  Each node gets: x = startX + index * (NODE_WIDTH + NODE_GAP_X)
                  y = layer * (NODE_HEIGHT + LAYER_GAP_Y)
```

The coordinate system is centered at (0, 0). The canvas `transform` handles viewport offset.

### Step 4: Edge Routing

For each edge:
- Start point: source node bottom-center `(node.x + NODE_WIDTH/2, node.y + NODE_HEIGHT)`
- End point: target node top-center `(node.x + NODE_WIDTH/2, node.y)`
- Control points for quadratic bezier: vertical midpoint between source and target

## Canvas Interaction

All implemented via pointer events and wheel events on the container div.

### Pan
- `pointerdown` on empty space → start drag, record start position
- `pointermove` → update translate offset
- `pointerup` → end drag

### Zoom
- `wheel` event → adjust scale factor
- Zoom center: mouse position (transform around cursor)
- Scale range: 0.3x to 2.0x
- Default scale: 1.0x

### Node Click
- `pointerdown` on a node (detect via data attribute or event delegation) → select node, update detail panel
- Click on empty space → deselect

### Implementation
```
transform: translate(panX, panY) scale(zoom)
```
Applied to the SVG `<g>` element wrapping all nodes and edges.

## Detail Panel

Fixed at bottom of the tab, outside the SVG canvas. Height: ~120px.

### Content When Selected

```
┌────────────────────────────────────────┐
│ [quest-color-bar] Quest Title          │
│                                        │
│ Summary text of the selected node      │
│ Hint: next step direction (active only)│
│                                   T: 3 │
└────────────────────────────────────────┘
```

Fields:
- Quest title with matching left color bar
- Node summary (always shown)
- Node hint (shown only for active nodes, italic, prefixed with hint label)
- Turn number (bottom-right, small muted text)

### Empty State

When no node is selected: centered muted text "点击节点查看详情".

## Empty Tab State

When `questGraph` is null or has zero quests: centered muted text "任务将在冒险过程中出现" (matches current behavior).

## Data Flow

No changes to the data model (`QuestGraph`, `QuestDelta`, protocol messages). The tab consumes `questGraph` from `useGameStore` exactly as before.

The layout algorithm runs in a `useMemo` hook keyed on `questGraph`, producing a positioned node/edge array that the SVG renders.

## Files Changed

| File | Change |
|------|--------|
| `web/src/tabs/QuestTab.tsx` | Full rewrite: DAG canvas + detail panel + layout algorithm + pan/zoom |
| `web/src/tabs/QuestTab.css` | Full rewrite: node styles, edge styles, detail panel, canvas container |

No backend changes. No new dependencies.

## Mobile (< 600px)

Same DAG rendering, same pan/zoom via touch gestures (pointer events work for touch). Detail panel stacks below the canvas. Node text may be smaller — rely on pinch-zoom to read.
