import { z } from 'zod/v4'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { LLMMessage } from '../../ai/runner/llm-provider.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { parseWithRepair } from '../../ai/parser/json-repair.js'
import type { IStateStore } from '../../infrastructure/storage/interfaces.js'
import type { CharacterDynamicState, MemoryBuffer } from '../models/character.js'
import { AtomicActionSchema } from '../models/pipeline-io.js'
import type { AtomicAction } from '../models/pipeline-io.js'

// ============================================================
// LLM Response Schema
// ============================================================

const NPCIntentSchema = z.object({
  intent: z.string(),
  atomic_actions: z.array(AtomicActionSchema).min(1),
})

type NPCIntent = z.infer<typeof NPCIntentSchema>

export interface NPCIntentResult {
  npc_id: string
  intent: string
  atomic_actions: AtomicAction[]
}

export class NPCIntentGenerator {
  private runner: AgentRunner
  private stateStore: IStateStore
  private parser: ResponseParser<NPCIntent>

  constructor(runner: AgentRunner, stateStore: IStateStore) {
    this.runner = runner
    this.stateStore = stateStore
    this.parser = new ResponseParser(NPCIntentSchema)
  }

  async generateIntent(npc_id: string): Promise<NPCIntentResult> {
    const state = await this.stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)

    if (!state) {
      throw new Error(`CharacterDynamicState not found for NPC: ${npc_id}`)
    }

    const activeGoals = state.goal_queue
      .filter((g) => g.status === 'IN_PROGRESS')
      .sort((a, b) => b.priority - a.priority)

    if (activeGoals.length === 0) {
      throw new Error(`No IN_PROGRESS goals for NPC: ${npc_id}`)
    }

    const memoryBuffer = await this.stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)

    const messages = this.buildMessages(state, memoryBuffer)
    const parsed = await this.callAndParse(messages)

    return {
      npc_id,
      intent: parsed.intent,
      atomic_actions: parsed.atomic_actions,
    }
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private buildMessages(
    state: CharacterDynamicState,
    memoryBuffer: MemoryBuffer | null,
  ): LLMMessage[] {
    const sections: string[] = []

    sections.push(`You are generating an autonomous action intent for NPC "${state.npc_id}".`)
    sections.push(`Current emotion: ${state.current_emotion}`)
    sections.push(`Current location: ${state.current_location_id}`)

    const activeGoals = state.goal_queue
      .filter((g) => g.status === 'IN_PROGRESS')
      .sort((a, b) => b.priority - a.priority)

    sections.push('\n[Active Goals (by priority)]')
    for (const goal of activeGoals) {
      sections.push(`- [P${goal.priority}] ${goal.description} (from event: ${goal.created_from_event_id ?? 'none'})`)
    }

    if (memoryBuffer && memoryBuffer.entries.length > 0) {
      const recentMemories = memoryBuffer.entries.slice(-5)
      sections.push('\n[Recent Memories]')
      for (const entry of recentMemories) {
        sections.push(`- ${entry.subjective_summary}`)
      }
    }

    sections.push(
      '\nBased on the NPC\'s goals, location, memories, and personality, decide what action the NPC should take next.',
      'Action types: MOVE_TO, SPEAK_TO, EXAMINE, GIVE, CONFRONT, WAIT, THINK',
      '',
      'Output JSON:',
      '{ "intent": "description of what the NPC wants to do", "atomic_actions": [{ "type": "...", "target": "..." | null, "method": "..." | null, "order": 0 }] }',
    )

    return [
      { role: 'system', content: sections.join('\n') },
      { role: 'user', content: `Generate the next action intent for NPC "${state.npc_id}".` },
    ]
  }

  private async callAndParse(messages: LLMMessage[]): Promise<NPCIntent> {
    const response = await this.runner.run(messages, {
      agent_type: 'npc_intent_generator',
      temperature: 0.7,
    })

    const result = await parseWithRepair(
      this.parser,
      this.runner,
      response.content,
      '{ "intent": string, "atomic_actions": [{ "type": string, "target": string|null, "method": string|null, "order": number }] }',
    )

    if (!result.success) {
      throw new Error(`Failed to parse NPC intent after repair: ${result.error.message}`)
    }
    return result.data
  }
}
