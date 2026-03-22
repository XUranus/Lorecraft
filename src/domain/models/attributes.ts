import { z } from 'zod/v4'

// ============================================================
// Attribute IDs
// ============================================================

export const ATTRIBUTE_IDS = [
  'strength',
  'constitution',
  'agility',
  'intelligence',
  'perception',
  'willpower',
  'charisma',
  'luck',
] as const

export const AttributeId = z.enum(ATTRIBUTE_IDS)
export type AttributeId = z.infer<typeof AttributeId>

export const ATTRIBUTE_TOTAL = 400

// ============================================================
// Attribute Metadata (static, display info + voice personality)
// ============================================================

export interface AttributeMeta {
  id: AttributeId
  display_name: string
  domain: string
  voice_personality: string
}

export const ATTRIBUTE_META: Record<AttributeId, AttributeMeta> = {
  strength: {
    id: 'strength',
    display_name: '力量',
    domain: '搏斗、搬运、破门、物理威慑',
    voice_personality: '好斗、直接，崇尚以力服人，鄙视迂回',
  },
  constitution: {
    id: 'constitution',
    display_name: '体质',
    domain: '耐力、抗打击、抗毒、长时间体力消耗',
    voice_personality: '沉稳、耐受，关注身体极限，劝你别逞强也别放弃',
  },
  agility: {
    id: 'agility',
    display_name: '敏捷',
    domain: '闪避、潜行、扒窃、反应速度',
    voice_personality: '机警、狡黠，总在找退路和捷径',
  },
  intelligence: {
    id: 'intelligence',
    display_name: '智力',
    domain: '推理、记忆、知识、计划',
    voice_personality: '冷酷理性，追求逻辑，瞧不起冲动',
  },
  perception: {
    id: 'perception',
    display_name: '感知',
    domain: '观察、搜索、读人、环境意识',
    voice_personality: '多疑、敏锐，什么细节都不放过，有时草木皆兵',
  },
  willpower: {
    id: 'willpower',
    display_name: '意志',
    domain: '抗压、抵抗诱惑/恐吓、精神韧性',
    voice_personality: '倔、硬，绝不妥协，有时固执到自毁',
  },
  charisma: {
    id: 'charisma',
    display_name: '魅力',
    domain: '说服、欺骗、领导力、第一印象',
    voice_personality: '圆滑、自信，把一切当谈判，有时过度自恋',
  },
  luck: {
    id: 'luck',
    display_name: '幸运',
    domain: '随机事件倾向、绝境转机、意外收获',
    voice_personality: '玩世不恭，赌徒心态，总觉得会有转机',
  },
}

// ============================================================
// Player Attributes (runtime state, persisted)
// ============================================================

export const PlayerAttributesSchema = z.object({
  strength: z.number().int().min(0).max(100),
  constitution: z.number().int().min(0).max(100),
  agility: z.number().int().min(0).max(100),
  intelligence: z.number().int().min(0).max(100),
  perception: z.number().int().min(0).max(100),
  willpower: z.number().int().min(0).max(100),
  charisma: z.number().int().min(0).max(100),
  luck: z.number().int().min(0).max(100),
})

export type PlayerAttributes = z.infer<typeof PlayerAttributesSchema>

// ============================================================
// Attribute Allocation
// ============================================================

/**
 * Generate a random attribute allocation that sums to ATTRIBUTE_TOTAL.
 * Each attribute is between 0 and 100.
 */
export function randomAllocate(): PlayerAttributes {
  const ids = [...ATTRIBUTE_IDS]
  const values: number[] = new Array(ids.length).fill(0)
  let remaining = ATTRIBUTE_TOTAL

  // Distribute points randomly using a "broken stick" approach
  // Generate random breakpoints, then sort and diff
  const breakpoints: number[] = []
  for (let i = 0; i < ids.length - 1; i++) {
    breakpoints.push(Math.random() * remaining)
  }
  breakpoints.sort((a, b) => a - b)

  values[0] = Math.round(breakpoints[0])
  for (let i = 1; i < ids.length - 1; i++) {
    values[i] = Math.round(breakpoints[i] - breakpoints[i - 1])
  }
  values[ids.length - 1] = remaining - values.slice(0, -1).reduce((a, b) => a + b, 0)

  // Clamp to [0, 100] and redistribute overflow
  for (let pass = 0; pass < 10; pass++) {
    let overflow = 0
    for (let i = 0; i < values.length; i++) {
      if (values[i] > 100) {
        overflow += values[i] - 100
        values[i] = 100
      }
      if (values[i] < 0) {
        overflow += values[i] // negative
        values[i] = 0
      }
    }
    if (overflow === 0) break
    // Distribute overflow to attributes that have room
    const eligible = values
      .map((v, i) => ({ i, room: overflow > 0 ? 100 - v : v }))
      .filter((e) => e.room > 0)
    if (eligible.length === 0) break
    const perAttr = Math.floor(Math.abs(overflow) / eligible.length)
    const sign = overflow > 0 ? 1 : -1
    for (const e of eligible) {
      const delta = Math.min(perAttr, e.room) * sign
      values[e.i] += delta
      overflow -= delta
    }
    // Distribute remainder one-by-one
    for (const e of eligible) {
      if (overflow === 0) break
      const delta = overflow > 0 ? Math.min(1, 100 - values[e.i]) : Math.max(-1, -values[e.i])
      values[e.i] += delta
      overflow -= delta
    }
  }

  const result: Record<string, number> = {}
  for (let i = 0; i < ids.length; i++) {
    result[ids[i]] = values[i]
  }
  return result as unknown as PlayerAttributes
}

/**
 * Validate a manual attribute allocation.
 * Returns null if valid, or an error message string.
 */
export function validateAllocation(attrs: PlayerAttributes): string | null {
  let total = 0
  for (const id of ATTRIBUTE_IDS) {
    const v = attrs[id]
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      return `${ATTRIBUTE_META[id].display_name} 的值 ${v} 不合法（需要0-100的整数）`
    }
    total += v
  }
  if (total !== ATTRIBUTE_TOTAL) {
    return `属性总和为 ${total}，需要恰好 ${ATTRIBUTE_TOTAL}`
  }
  return null
}

/**
 * Get the sum of all attribute values.
 */
export function attributeTotal(attrs: PlayerAttributes): number {
  let total = 0
  for (const id of ATTRIBUTE_IDS) {
    total += attrs[id]
  }
  return total
}
