import { z } from 'zod/v4'
import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import type { LLMMessage } from '../../ai/runner/llm-provider.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import { parseWithRepair } from '../../ai/parser/json-repair.js'
import { prompts } from '../../ai/prompt/prompts.js'
import type { IStateStore, ILoreStore, ILongTermMemoryStore } from '../../infrastructure/storage/interfaces.js'
import type { CharacterDynamicState, ConversationHistory, MemoryBuffer, TierCTemplate } from '../models/character.js'
import type { NPCProfile } from '../models/lore.js'
import type { NPCInjection } from '../models/injection.js'
import { ConversationManager } from './conversation-manager.js'

// ============================================================
// LLM Response Schema
// ============================================================

const NPCResponseSchema = z.object({
  response_text: z.string(),
  emotion_change: z.string().nullable(),
  relationship_change_signal: z.string().nullable(),
})

type NPCResponse = z.infer<typeof NPCResponseSchema>

export interface NPCResponseResult {
  response_text: string
  npc_id: string
}

export class NPCResponseGenerator {
  private runner: AgentRunner
  private stateStore: IStateStore
  private loreStore: ILoreStore
  private longTermMemoryStore: ILongTermMemoryStore
  private conversationManager: ConversationManager
  private parser: ResponseParser<NPCResponse>

  constructor(
    runner: AgentRunner,
    stateStore: IStateStore,
    loreStore: ILoreStore,
    longTermMemoryStore: ILongTermMemoryStore,
  ) {
    this.runner = runner
    this.stateStore = stateStore
    this.loreStore = loreStore
    this.longTermMemoryStore = longTermMemoryStore
    this.conversationManager = new ConversationManager(stateStore)
    this.parser = new ResponseParser(NPCResponseSchema)
  }

  async generateResponse(
    npc_id: string,
    player_input: string,
    session_id: string,
  ): Promise<NPCResponseResult> {
    const state = await this.stateStore.get<CharacterDynamicState>(`character:${npc_id}:state`)

    if (!state) {
      throw new Error(`CharacterDynamicState not found for NPC: ${npc_id}`)
    }

    switch (state.tier) {
      case 'A':
        return this.generateTierA(npc_id, player_input, session_id, state)
      case 'B':
        return this.generateTierB(npc_id, player_input, session_id, state)
      case 'C':
        return this.generateTierC(npc_id, player_input, state)
    }
  }

  // ============================================================
  // Tier A: Full pipeline with long-term memory + goal queue + injections
  // ============================================================

  private async generateTierA(
    npc_id: string,
    player_input: string,
    session_id: string,
    state: CharacterDynamicState,
  ): Promise<NPCResponseResult> {
    const [profile, history, memoryBuffer, longTermMemories, injections] = await Promise.all([
      this.loadProfile(npc_id),
      this.conversationManager.getHistory(session_id, npc_id),
      this.loadMemoryBuffer(npc_id),
      this.longTermMemoryStore.findRecent(npc_id, 5),
      this.loadInjections(npc_id),
    ])

    const activeGoals = state.goal_queue.filter((g) => g.status === 'IN_PROGRESS')

    const systemPrompt = this.buildTierASystemPrompt(profile, state, memoryBuffer, longTermMemories, activeGoals, injections)
    const messages = this.buildMessages(systemPrompt, history, player_input)

    const parsed = await this.callAndParse(messages, 'npc_response_tier_a')
    await this.applyStateUpdate(npc_id, session_id, player_input, parsed, state)
    await this.consumeInjections(injections)

    return { response_text: parsed.response_text, npc_id }
  }

  // ============================================================
  // Tier B: Simplified — no long-term memory, no goal queue
  // ============================================================

  private async generateTierB(
    npc_id: string,
    player_input: string,
    session_id: string,
    state: CharacterDynamicState,
  ): Promise<NPCResponseResult> {
    const [profile, history, memoryBuffer, injections] = await Promise.all([
      this.loadProfile(npc_id),
      this.conversationManager.getHistory(session_id, npc_id),
      this.loadMemoryBuffer(npc_id),
      this.loadInjections(npc_id),
    ])

    const systemPrompt = this.buildTierBSystemPrompt(profile, state, memoryBuffer, injections)
    const messages = this.buildMessages(systemPrompt, history, player_input)

    const parsed = await this.callAndParse(messages, 'npc_response_tier_b')
    await this.applyStateUpdate(npc_id, session_id, player_input, parsed, state)
    await this.consumeInjections(injections)

    return { response_text: parsed.response_text, npc_id }
  }

  // ============================================================
  // Tier C: Template-based, stateless
  // ============================================================

  private async generateTierC(
    npc_id: string,
    player_input: string,
    state: CharacterDynamicState,
  ): Promise<NPCResponseResult> {
    const templateId = npc_id // Convention: Tier C NPCs use their npc_id as template_id
    const template = await this.stateStore.get<TierCTemplate>(`npc:template:${templateId}`)

    if (!template) {
      throw new Error(`TierCTemplate not found for NPC: ${npc_id}`)
    }

    const systemPrompt = prompts.fill('npc_response_tier_c', {
      npc_type: template.type,
      personality_sketch: template.personality_sketch,
      default_response_style: template.default_response_style,
    })

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: player_input },
    ]

    const parsed = await this.callAndParse(messages, 'npc_response_tier_c')

    // Tier C: increment interaction_count only (no conversation or memory persistence)
    state.interaction_count += 1
    await this.stateStore.set(`character:${npc_id}:state`, state)

    return { response_text: parsed.response_text, npc_id }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async loadProfile(npc_id: string): Promise<NPCProfile | null> {
    const entries = await this.loreStore.findBySubject(npc_id)
    if (entries.length === 0) return null

    return {
      npc_id,
      personal_facts: entries.filter((e) => e.fact_type === 'NPC_PERSONAL').map((e) => e.content),
      known_relationships: entries.filter((e) => e.fact_type === 'RELATIONSHIP').map((e) => e.content),
      last_synced_turn: Math.max(...entries.map((e) => e.created_at_turn)),
    }
  }

  private async loadMemoryBuffer(npc_id: string): Promise<MemoryBuffer | null> {
    return this.stateStore.get<MemoryBuffer>(`character:${npc_id}:memory_buffer`)
  }

  private async loadInjections(npc_id: string): Promise<NPCInjection[]> {
    const injections = await this.stateStore.get<NPCInjection[]>(`npc:injections:${npc_id}`)
    return injections ?? []
  }

  private async consumeInjections(injections: NPCInjection[]): Promise<void> {
    for (const injection of injections) {
      await this.stateStore.delete(`npc:injection:${injection.id}`)
    }
    if (injections.length > 0) {
      await this.stateStore.set(`npc:injections:${injections[0].npc_id}`, [])
    }
  }

  private buildTierASystemPrompt(
    profile: NPCProfile | null,
    state: CharacterDynamicState,
    memoryBuffer: MemoryBuffer | null,
    longTermMemories: { subjective_summary: string }[],
    activeGoals: { description: string; priority: number }[],
    injections: NPCInjection[],
  ): string {
    const sections: string[] = []

    sections.push(`[NPC ID: ${state.npc_id}] [Tier: A] [Emotion: ${state.current_emotion}] [Location: ${state.current_location_id}]`)

    if (profile) {
      sections.push(`\n[Personal Facts]\n${profile.personal_facts.join('\n')}`)
      if (profile.known_relationships.length > 0) {
        sections.push(`\n[Known Relationships]\n${profile.known_relationships.join('\n')}`)
      }
    }

    if (memoryBuffer && memoryBuffer.entries.length > 0) {
      const recentMemories = memoryBuffer.entries.slice(-5).map((e) => e.subjective_summary)
      sections.push(`\n[Recent Memories]\n${recentMemories.join('\n')}`)
    }

    if (longTermMemories.length > 0) {
      sections.push(`\n[Long-Term Memories]\n${longTermMemories.map((m) => m.subjective_summary).join('\n')}`)
    }

    if (activeGoals.length > 0) {
      const goalText = activeGoals
        .sort((a, b) => b.priority - a.priority)
        .map((g) => `- [P${g.priority}] ${g.description}`)
        .join('\n')
      sections.push(`\n[Active Goals]\n${goalText}`)
    }

    if (injections.length > 0) {
      sections.push(`\n[Narrative Directives]\n${injections.map((i) => `- ${i.context} (condition: ${i.condition})`).join('\n')}`)
    }

    sections.push(
      '\nRespond in character. Output JSON:',
      '{ "response_text": "...", "emotion_change": "..." | null, "relationship_change_signal": "..." | null }',
    )

    return sections.join('\n')
  }

  private buildTierBSystemPrompt(
    profile: NPCProfile | null,
    state: CharacterDynamicState,
    memoryBuffer: MemoryBuffer | null,
    injections: NPCInjection[],
  ): string {
    const sections: string[] = []

    sections.push(`[NPC ID: ${state.npc_id}] [Tier: B] [Emotion: ${state.current_emotion}] [Location: ${state.current_location_id}]`)

    if (profile) {
      sections.push(`\n[Personal Facts]\n${profile.personal_facts.join('\n')}`)
      if (profile.known_relationships.length > 0) {
        sections.push(`\n[Known Relationships]\n${profile.known_relationships.join('\n')}`)
      }
    }

    if (memoryBuffer && memoryBuffer.entries.length > 0) {
      const recentMemories = memoryBuffer.entries.slice(-5).map((e) => e.subjective_summary)
      sections.push(`\n[Recent Memories]\n${recentMemories.join('\n')}`)
    }

    if (injections.length > 0) {
      sections.push(`\n[Narrative Directives]\n${injections.map((i) => `- ${i.context} (condition: ${i.condition})`).join('\n')}`)
    }

    sections.push(
      '\nRespond in character. Output JSON:',
      '{ "response_text": "...", "emotion_change": "..." | null, "relationship_change_signal": "..." | null }',
    )

    return sections.join('\n')
  }

  private buildMessages(
    systemPrompt: string,
    history: ConversationHistory,
    player_input: string,
  ): LLMMessage[] {
    const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }]

    for (const turn of history.turns) {
      messages.push({
        role: turn.role === 'PLAYER' ? 'user' : 'assistant',
        content: turn.content,
      })
    }

    messages.push({ role: 'user', content: player_input })
    return messages
  }

  private async callAndParse(messages: LLMMessage[], agentType: string): Promise<NPCResponse> {
    const response = await this.runner.run(messages, {
      agent_type: agentType,
      temperature: 0.7,
    })

    const result = await parseWithRepair(
      this.parser,
      this.runner,
      response.content,
      '{ "response_text": string, "emotion_change": string|null, "relationship_change_signal": string|null }',
    )

    if (!result.success) {
      throw new Error(`Failed to parse NPC response after repair: ${result.error.message}`)
    }
    return result.data
  }

  private async applyStateUpdate(
    npc_id: string,
    session_id: string,
    player_input: string,
    parsed: NPCResponse,
    state: CharacterDynamicState,
  ): Promise<void> {
    // Update emotion if changed
    if (parsed.emotion_change) {
      state.current_emotion = parsed.emotion_change
    }

    // Increment interaction count
    state.interaction_count += 1

    await this.stateStore.set(`character:${npc_id}:state`, state)

    // Append conversation turns
    const history = await this.conversationManager.getHistory(session_id, npc_id)
    const nextTurn = history.turns.length > 0
      ? Math.max(...history.turns.map((t) => t.turn_number)) + 1
      : 1

    await this.conversationManager.appendTurn(session_id, npc_id, 'PLAYER', player_input, nextTurn)
    await this.conversationManager.appendTurn(session_id, npc_id, 'NPC', parsed.response_text, nextTurn + 1)
    await this.conversationManager.compressIfNeeded(session_id, npc_id)
  }
}
