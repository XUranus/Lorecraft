import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import type { ILoreStore, IStateStore } from '../../infrastructure/storage/interfaces.js'
import type { LoreEntry, NPCProfile } from '../../domain/models/lore.js'
import { z } from 'zod/v4'

// ============================================================
// Schemas
// ============================================================

const ExtractedFactSchema = z.object({
  content: z.string(),
  fact_type: z.enum(['NPC_PERSONAL', 'WORLD', 'RELATIONSHIP', 'ORGANIZATION']),
  subject_ids: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>

const FactExtractionResultSchema = z.object({
  facts: z.array(ExtractedFactSchema),
})

const ConsistencyVerdictSchema = z.object({
  verdict: z.enum(['CONSISTENT', 'SUPPLEMENTARY', 'CONTRADICTORY']),
  reasoning: z.string(),
})

export type ConsistencyVerdict = z.infer<typeof ConsistencyVerdictSchema>

// ============================================================
// LoreCanonicalizer
// ============================================================

export class LoreCanonicalizer {
  private readonly agentRunner: AgentRunner
  private readonly loreStore: ILoreStore
  private readonly stateStore: IStateStore
  private readonly factParser = new ResponseParser(FactExtractionResultSchema)
  private readonly consistencyParser = new ResponseParser(ConsistencyVerdictSchema)

  constructor(agentRunner: AgentRunner, loreStore: ILoreStore, stateStore: IStateStore) {
    this.agentRunner = agentRunner
    this.loreStore = loreStore
    this.stateStore = stateStore
  }

  async extractFacts(narrativeText: string, eventId: string): Promise<ExtractedFact[]> {
    const systemPrompt = [
      'You are the FactExtractor for a CRPG lore system.',
      'Extract concrete facts from the narrative text.',
      'Only extract NEW information (names, relationships, locations, etc), not descriptions of actions.',
      'Respond with ONLY valid JSON: { "facts": [{ "content": string, "fact_type": "NPC_PERSONAL"|"WORLD"|"RELATIONSHIP"|"ORGANIZATION", "subject_ids": string[], "confidence": 0-1 }] }',
    ].join('\n')

    const userMessage = JSON.stringify({
      narrative_text: narrativeText,
      event_id: eventId,
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'FactExtractor' },
      )

      const result = this.factParser.parse(response.content)
      if (result.success) {
        return result.data.facts.filter((f) => f.confidence >= 0.5)
      }
    } catch {
      // Extraction failed
    }
    return []
  }

  async checkConsistency(
    fact: ExtractedFact,
    existingLore: LoreEntry[],
  ): Promise<ConsistencyVerdict> {
    if (existingLore.length === 0) {
      return { verdict: 'SUPPLEMENTARY', reasoning: 'No existing lore to compare' }
    }

    const systemPrompt = [
      'You are the LoreConsistencyChecker.',
      'Compare a new fact against existing lore entries.',
      'Determine if the new fact is consistent, supplementary (adds new info), or contradictory.',
      'Respond with ONLY valid JSON: { "verdict": "CONSISTENT"|"SUPPLEMENTARY"|"CONTRADICTORY", "reasoning": string }',
    ].join('\n')

    const userMessage = JSON.stringify({
      new_fact: fact.content,
      existing_lore: existingLore.map((l) => ({
        id: l.id,
        content: l.content,
        authority: l.authority_level,
      })),
    })

    try {
      const response = await this.agentRunner.run(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { agent_type: 'LoreConsistencyChecker' },
      )

      const result = this.consistencyParser.parse(response.content)
      if (result.success) {
        return result.data
      }
    } catch {
      // Check failed
    }
    return { verdict: 'CONSISTENT', reasoning: 'Check unavailable, defaulting to consistent' }
  }

  async canonicalize(
    narrativeText: string,
    eventId: string,
    currentTurn: number,
  ): Promise<LoreEntry[]> {
    const facts = await this.extractFacts(narrativeText, eventId)
    const newEntries: LoreEntry[] = []

    for (const fact of facts) {
      const contentHash = this.simpleHash(fact.content)

      // Idempotent: skip if content already exists
      const existing = await this.loreStore.findByContentHash(contentHash)
      if (existing) continue

      // Gather existing lore for all subjects
      const existingLore: LoreEntry[] = []
      for (const subjectId of fact.subject_ids) {
        const entries = await this.loreStore.findBySubject(subjectId)
        for (const entry of entries) {
          if (!existingLore.some((e) => e.id === entry.id)) {
            existingLore.push(entry)
          }
        }
      }

      const verdict = await this.checkConsistency(fact, existingLore)

      if (verdict.verdict === 'CONSISTENT' || verdict.verdict === 'SUPPLEMENTARY') {
        const entry: LoreEntry = {
          id: crypto.randomUUID(),
          content: fact.content,
          fact_type: fact.fact_type,
          authority_level: 'AI_CANONICALIZED',
          subject_ids: fact.subject_ids,
          source_event_id: eventId,
          created_at_turn: currentTurn,
          causal_chain: [],
          related_lore_ids: existingLore.map((l) => l.id),
          content_hash: contentHash,
        }
        await this.loreStore.append(entry)
        newEntries.push(entry)
      } else if (verdict.verdict === 'CONTRADICTORY') {
        // Check if any existing lore is AUTHOR_PRESET
        const hasAuthorPreset = existingLore.some((l) => l.authority_level === 'AUTHOR_PRESET')
        if (hasAuthorPreset) {
          // Author preset cannot be overridden — discard
          continue
        }

        // All AI_CANONICALIZED: update the most recent entry
        if (existingLore.length > 0) {
          const mostRecent = existingLore.reduce((a, b) =>
            a.created_at_turn > b.created_at_turn ? a : b,
          )

          await this.loreStore.update(mostRecent.id, {
            content: fact.content,
            content_hash: contentHash,
            causal_chain: [
              ...mostRecent.causal_chain,
              {
                before_content: mostRecent.content,
                change_reason: verdict.reasoning,
                after_content: fact.content,
                caused_by_event_id: eventId,
                timestamp: { day: 0, hour: 0, turn: currentTurn },
              },
            ],
          })
        }
      }

      // Sync NPCProfile cache for each subject
      for (const subjectId of fact.subject_ids) {
        await this.syncNPCProfile(subjectId, fact, currentTurn)
      }
    }

    return newEntries
  }

  private async syncNPCProfile(
    subjectId: string,
    fact: ExtractedFact,
    currentTurn: number,
  ): Promise<void> {
    const profileKey = `npc:profile:${subjectId}`
    const profile = await this.stateStore.get<NPCProfile>(profileKey)

    if (profile) {
      const updates: Partial<NPCProfile> = { last_synced_turn: currentTurn }
      if (fact.fact_type === 'NPC_PERSONAL') {
        updates.personal_facts = [...profile.personal_facts, fact.content]
      } else if (fact.fact_type === 'RELATIONSHIP') {
        updates.known_relationships = [...profile.known_relationships, fact.content]
      }
      await this.stateStore.set(profileKey, { ...profile, ...updates })
    }
  }

  private simpleHash(str: string): string {
    // djb2 hash
    let hash = 5381
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }
}
