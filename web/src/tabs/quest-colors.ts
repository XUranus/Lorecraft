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
