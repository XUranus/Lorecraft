import { z } from 'zod/v4'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { LLMMessage } from '../../ai/runner/llm-provider.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { parseWithRepair } from '../../ai/parser/json-repair.js'
import type { IStateStore, ILongTermMemoryStore, LongTermMemoryEntry } from '../../infrastructure/storage/interfaces.js'
import type { CharacterDynamicState, MemoryBuffer, MemoryBufferEntry, RelationshipEntry } from '../models/character.js'

// ============================================================
// LLM Response Schema
// ============================================================

const SubjectiveMemorySchema = z.object({
  subjective_summary: z.string(),
  distortion_type: z.enum(['NONE', 'INFO_GAP', 'INTENT_MISREAD', 'EMOTIONAL_DISTORTION']),
})

type SubjectiveMemory = z.infer<typeof SubjectiveMemorySchema>

export interface MemoryEventInput {
  id: string
  summary: string
  narrative_text?: string
  participant_ids: string[]
  location_id: string
}

export class SubjectiveMemoryGenerator {
  private runner: AgentRunner
  private stateStore: IStateStore
  private longTermMemoryStore: ILongTermMemoryStore
  private parser: ResponseParser<SubjectiveMemory>

  constructor(
    runner: AgentRunner,
    stateStore: IStateStore,
    longTermMemoryStore: ILongTermMemoryStore,
  ) {
    this.runner = runner
    this.stateStore = stateStore
    this.longTermMemoryStore = longTermMemoryStore
    this.parser = new ResponseParser(SubjectiveMemorySchema)
  }

  async generateMemory(npc_id: string, event: MemoryEventInput): Promise<void> {
    const state = await this.stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)

    if (!state) {
      throw new Error(`CharacterDynamicState not found for NPC: ${npc_id}`)
    }

    // Only Tier A and Tier B NPCs generate subjective memories
    if (state.tier === 'C') {
      return
    }

    // Load relationships with event participants
    const relationships = await this.loadRelationships(npc_id, event.participant_ids)

    const messages = this.buildMessages(state, event, relationships)
    const parsed = await this.callAndParse(messages)

    await this.appendToMemoryBuffer(npc_id, state.tier, event, parsed)
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private async loadRelationships(
    npc_id: string,
    participant_ids: string[],
  ): Promise<RelationshipEntry[]> {
    const results: RelationshipEntry[] = []

    for (const pid of participant_ids) {
      if (pid === npc_id) continue
      const rel = await this.stateStore.get<RelationshipEntry>(`relationship:${npc_id}:${pid}`)
      if (rel) results.push(rel)
    }

    return results
  }

  private buildMessages(
    state: CharacterDynamicState,
    event: MemoryEventInput,
    relationships: RelationshipEntry[],
  ): LLMMessage[] {
    const sections: string[] = []

    sections.push(`You are generating a subjective memory for NPC "${state.npc_id}".`)
    sections.push(`Current emotion: ${state.current_emotion}`)
    sections.push(`Location: ${state.current_location_id}`)

    sections.push(`\n[Event Summary]\n${event.summary}`)
    if (event.narrative_text) {
      sections.push(`\n[Event Narrative]\n${event.narrative_text}`)
    }

    sections.push(`\n[Event Participants]: ${event.participant_ids.join(', ')}`)
    sections.push(`[Event Location]: ${event.location_id}`)

    if (relationships.length > 0) {
      const relText = relationships
        .map((r) => `- ${r.to_npc_id}: ${r.semantic_description} (strength: ${r.strength})`)
        .join('\n')
      sections.push(`\n[NPC Relationships with Participants]\n${relText}`)
    }

    sections.push(
      '\nGenerate this NPC\'s subjective memory of the event. The memory should reflect the NPC\'s personality, emotions, and biases.',
      'Distortion types:',
      '- NONE: objective recollection',
      '- INFO_GAP: NPC was not present or lacks information',
      '- INTENT_MISREAD: NPC misinterprets others\' motives',
      '- EMOTIONAL_DISTORTION: NPC\'s emotional state colors the memory',
      '',
      'Output JSON: { "subjective_summary": "...", "distortion_type": "NONE" | "INFO_GAP" | "INTENT_MISREAD" | "EMOTIONAL_DISTORTION" }',
    )

    return [
      { role: 'system', content: sections.join('\n') },
      { role: 'user', content: `Generate the subjective memory for event "${event.id}".` },
    ]
  }

  private async callAndParse(messages: LLMMessage[]): Promise<SubjectiveMemory> {
    const response = await this.runner.run(messages, {
      agent_type: 'subjective_memory_generator',
      temperature: 0.7,
    })

    const result = await parseWithRepair(
      this.parser,
      this.runner,
      response.content,
      '{ "subjective_summary": string, "distortion_type": "NONE"|"INFO_GAP"|"INTENT_MISREAD"|"EMOTIONAL_DISTORTION" }',
    )

    if (!result.success) {
      throw new Error(`Failed to parse subjective memory after repair: ${result.error.message}`)
    }
    return result.data
  }

  private async appendToMemoryBuffer(
    npc_id: string,
    tier: 'A' | 'B',
    event: MemoryEventInput,
    parsed: SubjectiveMemory,
  ): Promise<void> {
    const bufferKey = `character:${npc_id}:memory_buffer`
    let buffer = await this.stateStore.get<MemoryBuffer>(bufferKey)

    if (!buffer) {
      buffer = {
        npc_id,
        entries: [],
        max_size: tier === 'A' ? 20 : 5,
      }
    }

    const newEntry: MemoryBufferEntry = {
      event_id: event.id,
      subjective_summary: parsed.subjective_summary,
      distortion_type: parsed.distortion_type,
      recorded_at_turn: Date.now(), // Caller should ideally provide current turn
    }

    buffer.entries.push(newEntry)

    // Handle overflow
    while (buffer.entries.length > buffer.max_size) {
      const evicted = buffer.entries.shift()!

      if (tier === 'A') {
        // Write evicted entry to long-term memory store
        const longTermEntry: LongTermMemoryEntry = {
          event_id: evicted.event_id,
          npc_id,
          subjective_summary: evicted.subjective_summary,
          participant_ids: event.participant_ids,
          location_id: event.location_id,
          recorded_at_turn: evicted.recorded_at_turn,
          distortion_type: evicted.distortion_type,
        }
        await this.longTermMemoryStore.append(longTermEntry)
      }
      // Tier B: evicted entries are discarded
    }

    await this.stateStore.set(bufferKey, buffer)
  }
}
