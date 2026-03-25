import type { AgentRunner } from '../../ai/runner/agent-runner.js'
import { ResponseParser } from '../../ai/parser/response-parser.js'
import type {
  IStateStore,
  IEventStore,
  ISessionStore,
  ILoreStore,
} from '../../infrastructure/storage/interfaces.js'
import { GenesisDocumentSchema } from '../models/genesis.js'
import type { GenesisDocument } from '../models/genesis.js'
import type { Event } from '../models/event.js'
import type { LocationState } from '../models/world.js'
import type { FactionState, FactionRelationship } from '../models/world.js'
import type { CharacterDynamicState, MemoryBuffer, CharacterKnowledge } from '../models/character.js'
import type { LoreEntry } from '../models/lore.js'
import type { NPCProfile } from '../models/lore.js'
import type { EventBus } from './event-bus.js'
import type { ExtensionConfigLoader, StyleConfig } from './extension-config.js'

// ============================================================
// InitializationAgent
// ============================================================

export class InitializationAgent {
  private readonly agentRunner: AgentRunner
  private readonly stateStore: IStateStore
  private readonly eventStore: IEventStore
  private readonly sessionStore: ISessionStore
  private readonly loreStore: ILoreStore
  private readonly eventBus: EventBus | null
  private readonly configLoader: ExtensionConfigLoader
  private readonly genesisParser = new ResponseParser(GenesisDocumentSchema)
  private readonly onProgress: (msg: string) => void

  constructor(deps: {
    agentRunner: AgentRunner
    stateStore: IStateStore
    eventStore: IEventStore
    sessionStore: ISessionStore
    loreStore: ILoreStore
    eventBus?: EventBus
    configLoader: ExtensionConfigLoader
    onProgress?: (msg: string) => void
  }) {
    this.agentRunner = deps.agentRunner
    this.stateStore = deps.stateStore
    this.eventStore = deps.eventStore
    this.sessionStore = deps.sessionStore
    this.loreStore = deps.loreStore
    this.eventBus = deps.eventBus ?? null
    this.configLoader = deps.configLoader
    this.onProgress = deps.onProgress ?? (() => {})
  }

  /**
   * Run the full 6-step initialization pipeline.
   * Returns the generated GenesisDocument.
   */
  async initialize(): Promise<GenesisDocument> {
    const t0 = Date.now()

    // Step 1: Load style config
    this.onProgress('正在加载风格配置…')
    const styleConfig = this.configLoader.getStyleConfig()

    // Step 2: Generate GenesisDocument via LLM
    this.onProgress('正在调用大模型生成世界…')
    const genesisDoc = await this.generateGenesisDocument(styleConfig)
    this.onProgress(`世界生成完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

    // Step 3: Validation (handled by ResponseParser in step 2)

    // Step 4: Persist genesis document
    this.onProgress('正在保存创世文档…')
    await this.sessionStore.saveGenesis(genesisDoc)

    // Step 5: Distribute to modules (strict ordering)
    this.onProgress('正在初始化世界状态…')
    await this.distributeToModules(genesisDoc)

    // Step 6: Broadcast inciting event
    this.onProgress('正在生成序幕事件…')
    await this.broadcastIncitingEvent(genesisDoc)

    this.onProgress(`初始化完成 (总计 ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    return genesisDoc
  }

  /**
   * Re-initialize from existing genesis document (replay same world).
   */
  async initializeFromExisting(genesisDocumentId: string): Promise<GenesisDocument | null> {
    const genesisDoc = await this.sessionStore.loadGenesis(genesisDocumentId)
    if (!genesisDoc) return null

    await this.distributeToModules(genesisDoc)
    await this.broadcastIncitingEvent(genesisDoc)

    return genesisDoc
  }

  // ---- Step 2: WorldGenerator LLM Call ----

  private async generateGenesisDocument(
    styleConfig: StyleConfig,
    maxRetries = 3,
  ): Promise<GenesisDocument> {
    let lastError = ''

    const schemaHint = `
STRICT JSON SCHEMA (follow EXACTLY):
{
  "world_setting": {
    "background": "string - world background description",
    "tone": "string - narrative tone",
    "core_conflict": "string - central conflict",
    "hidden_secrets": ["string array - secrets hidden from player"],
    "factions": [{
      "id": "string",
      "name": "string",
      "description": "string",
      "initial_strength": "WEAK" | "MODERATE" | "STRONG" | "DOMINANT",
      "initial_resources": "string",
      "initial_relationships": {
        "other_faction_id": {
          "relation_type": "ALLIED" | "NEUTRAL" | "HOSTILE" | "UNKNOWN",
          "description": "string"
        }
      }
    }]
  },
  "narrative_structure": {
    "final_goal_description": "string",
    "inciting_event": {
      "title": "string",
      "description": "string",
      "location_id": "string - must match a location id",
      "participant_ids": ["string array - character ids involved"],
      "narrative_text": "string - the opening narrative text"
    },
    "phases": [{
      "phase_id": "string",
      "description": "string",
      "direction_summary": "string - REQUIRED"
    }]
  },
  "characters": {
    "player_character": { "id": "string", "name": "string", "background": "string" },
    "tier_a_npcs": [{
      "id": "string",
      "name": "string",
      "background": "string",
      "surface_motivation": "string",
      "deep_motivation": "string",
      "secrets": ["string array"],
      "initial_relationships": { "other_npc_id": "string description" }
    }],
    "tier_b_npcs": [{
      "id": "string",
      "name": "string",
      "background": "string",
      "role_description": "string"
    }]
  },
  "initial_locations": [{
    "id": "string",
    "name": "string",
    "region_id": "string",
    "description": "string",
    "initial_status": "string",
    "connections": [{
      "to_location_id": "string",
      "traversal_condition": "OPEN" | "REQUIRES_KEY" | "REQUIRES_EVENT" | "BLOCKED",
      "condition_detail": "string or null",
      "travel_time_turns": number
    }]
  }]
}

CRITICAL RULES:
- Do NOT include "id" or "created_at" at the top level (they will be auto-generated)
- Enum values MUST be UPPERCASE: "WEAK"/"MODERATE"/"STRONG"/"DOMINANT", "ALLIED"/"NEUTRAL"/"HOSTILE"/"UNKNOWN", "OPEN"/"REQUIRES_KEY"/"REQUIRES_EVENT"/"BLOCKED"
- tier_a_npcs: 3-7 NPCs, each must have initial_relationships referencing other NPC ids
- If NPC A references NPC B, NPC B MUST reference NPC A back
- phases: at least 3, each MUST have direction_summary
- initial_locations: at least 3, with connections between them
- inciting_event.location_id must be one of the location ids
- All content in Chinese (中文)
`

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.onProgress(`大模型调用中… (第 ${attempt + 1}/${maxRetries} 次尝试)${lastError ? ` [上次失败: ${lastError.slice(0, 120)}]` : ''}`)

      const systemPrompt = [
        'You are the WorldGenerator for a CRPG engine (对话式角色扮演游戏).',
        `Game Style: ${styleConfig.tone}`,
        `Complexity: ${styleConfig.complexity}`,
        `Narrative Style: ${styleConfig.narrative_style}`,
        `Player Archetype: ${styleConfig.player_archetype}`,
        '',
        schemaHint,
        lastError ? `\n上一次尝试失败原因: ${lastError}\n请修正这些问题。` : '',
        '',
        'Respond with ONLY valid JSON. No markdown, no explanation, just JSON.',
      ]
        .filter(Boolean)
        .join('\n')

      const callStart = Date.now()
      try {
        const response = await this.agentRunner.run(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '生成一个新的游戏世界。只输出JSON。' },
          ],
          { agent_type: 'WorldGenerator' },
        )
        this.onProgress(`大模型返回 (${((Date.now() - callStart) / 1000).toFixed(1)}s)，正在解析…`)

        // Pre-process: inject metadata fields and normalize enums
        const preprocessed = this.preprocessLLMOutput(response.content)

        const result = this.genesisParser.parse(preprocessed)
        if (result.success) {
          const validationErrors = this.validateGenesisConsistency(result.data)
          if (validationErrors.length === 0) {
            const npcCount = result.data.characters.tier_a_npcs.length + result.data.characters.tier_b_npcs.length
            const locCount = result.data.initial_locations.length
            this.onProgress(`解析成功: ${npcCount} 个NPC, ${locCount} 个地点, ${result.data.narrative_structure.phases.length} 个叙事阶段`)
            return result.data
          }
          lastError = validationErrors.join('; ')
          this.onProgress(`一致性检查失败: ${lastError}`)
        } else {
          lastError = result.error.message
          this.onProgress(`JSON解析失败: ${lastError.slice(0, 120)}`)
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        this.onProgress(`调用失败: ${lastError.slice(0, 120)}`)
      }
    }

    throw new Error(`WorldGenerator failed after ${maxRetries} attempts: ${lastError}`)
  }

  /**
   * Pre-process LLM output:
   * - Inject id/created_at if missing
   * - Normalize enum values to uppercase
   */
  private preprocessLLMOutput(raw: string): string {
    // Extract JSON first
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
    let jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : raw

    const jsonMatch = jsonStr.match(/(\{[\s\S]*\})/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1]
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      return raw // Let the parser handle the error
    }

    // Inject top-level metadata if missing
    if (!parsed.id) {
      parsed.id = crypto.randomUUID()
    }
    if (!parsed.created_at) {
      parsed.created_at = Date.now()
    }

    // Normalize enum values throughout the object
    const normalized = this.normalizeEnums(parsed)

    return JSON.stringify(normalized)
  }

  private normalizeEnums(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj
    if (typeof obj === 'string') {
      // Known enum values → uppercase
      const ENUM_MAP: Record<string, string> = {
        weak: 'WEAK', moderate: 'MODERATE', strong: 'STRONG', dominant: 'DOMINANT',
        allied: 'ALLIED', neutral: 'NEUTRAL', hostile: 'HOSTILE', unknown: 'UNKNOWN',
        open: 'OPEN', requires_key: 'REQUIRES_KEY', requires_event: 'REQUIRES_EVENT', blocked: 'BLOCKED',
      }
      return ENUM_MAP[obj.toLowerCase()] ?? obj
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.normalizeEnums(item))
    }
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        // Only normalize values for known enum fields
        if (
          key === 'initial_strength' ||
          key === 'relation_type' ||
          key === 'traversal_condition'
        ) {
          result[key] = typeof value === 'string' ? this.normalizeEnums(value) : value
        } else {
          result[key] = this.normalizeEnums(value)
        }
      }
      return result
    }
    return obj
  }

  private validateGenesisConsistency(doc: GenesisDocument): string[] {
    const errors: string[] = []

    // Check Tier A NPC count
    if (doc.characters.tier_a_npcs.length < 3 || doc.characters.tier_a_npcs.length > 7) {
      errors.push(`tier_a_npcs count ${doc.characters.tier_a_npcs.length} not in [3,7]`)
    }

    // Check narrative phases non-empty
    if (doc.narrative_structure.phases.length === 0) {
      errors.push('narrative_structure.phases is empty')
    }

    // Check each phase has direction_summary
    for (const phase of doc.narrative_structure.phases) {
      if (!phase.direction_summary || phase.direction_summary.trim().length === 0) {
        errors.push(`Phase ${phase.phase_id} missing direction_summary`)
      }
    }

    // Check NPC relationship consistency
    const npcIds = new Set(doc.characters.tier_a_npcs.map((n) => n.id))
    for (const npc of doc.characters.tier_a_npcs) {
      for (const refId of Object.keys(npc.initial_relationships)) {
        if (npcIds.has(refId)) {
          const refNpc = doc.characters.tier_a_npcs.find((n) => n.id === refId)
          if (refNpc && !(npc.id in refNpc.initial_relationships)) {
            errors.push(`NPC ${npc.id} references ${refId} but ${refId} doesn't reference back`)
          }
        }
      }
    }

    return errors
  }

  // ---- Step 5: Distribute to Modules ----

  private async distributeToModules(doc: GenesisDocument): Promise<void> {
    // 5a. LoreStore: Write AUTHOR_PRESET lore
    await this.writeAuthorPresetLore(doc)

    // 5b. StateStore: Locations, factions, graph
    await this.writeWorldState(doc)

    // 5c. Character states
    await this.writeCharacterStates(doc)

    // 5d. Narrative rail setup
    await this.setupNarrativeRail(doc)

    // 5e. Inciting event (written last)
    // Done in broadcastIncitingEvent
  }

  private async writeAuthorPresetLore(doc: GenesisDocument): Promise<void> {
    // World setting as lore
    const worldLore: LoreEntry = {
      id: crypto.randomUUID(),
      content: `${doc.world_setting.background}\n核心冲突：${doc.world_setting.core_conflict}`,
      fact_type: 'WORLD',
      authority_level: 'AUTHOR_PRESET',
      subject_ids: ['world'],
      source_event_id: null,
      created_at_turn: 0,
      causal_chain: [],
      related_lore_ids: [],
      content_hash: this.simpleHash(doc.world_setting.background),
    }
    await this.loreStore.append(worldLore)

    // Hidden secrets as lore
    for (const secret of doc.world_setting.hidden_secrets) {
      await this.loreStore.append({
        id: crypto.randomUUID(),
        content: secret,
        fact_type: 'WORLD',
        authority_level: 'AUTHOR_PRESET',
        subject_ids: ['world', 'secret'],
        source_event_id: null,
        created_at_turn: 0,
        causal_chain: [],
        related_lore_ids: [],
        content_hash: this.simpleHash(secret),
      })
    }

    // NPC profiles as lore
    for (const npc of doc.characters.tier_a_npcs) {
      await this.loreStore.append({
        id: crypto.randomUUID(),
        content: `${npc.name}：${npc.background}`,
        fact_type: 'NPC_PERSONAL',
        authority_level: 'AUTHOR_PRESET',
        subject_ids: [npc.id],
        source_event_id: null,
        created_at_turn: 0,
        causal_chain: [],
        related_lore_ids: [],
        content_hash: this.simpleHash(npc.background),
      })

      // NPC Profile cache
      const profile: NPCProfile = {
        npc_id: npc.id,
        personal_facts: [npc.background],
        known_relationships: Object.entries(npc.initial_relationships).map(
          ([targetId, desc]) => `${targetId}: ${desc}`,
        ),
        last_synced_turn: 0,
      }
      await this.stateStore.set(`npc:profile:${npc.id}`, profile)
    }

    // Faction lore
    for (const faction of doc.world_setting.factions) {
      await this.loreStore.append({
        id: crypto.randomUUID(),
        content: `${faction.name}：${faction.description}`,
        fact_type: 'ORGANIZATION',
        authority_level: 'AUTHOR_PRESET',
        subject_ids: [faction.id],
        source_event_id: null,
        created_at_turn: 0,
        causal_chain: [],
        related_lore_ids: [],
        content_hash: this.simpleHash(faction.description),
      })
    }
  }

  private async writeWorldState(doc: GenesisDocument): Promise<void> {
    // Location states
    for (const loc of doc.initial_locations) {
      const locationState: LocationState = {
        id: loc.id,
        name: loc.name,
        region_id: loc.region_id,
        current_status: loc.initial_status,
        accessibility: 'OPEN',
        current_occupant_ids: [],
        is_frozen: false,
        last_observed_turn: 0,
        causal_chain: [],
      }
      await this.stateStore.set(`location:state:${loc.id}`, locationState)
      await this.stateStore.set(`location:region:${loc.id}`, loc.region_id)
    }

    // Location edges (connectivity graph)
    const allEdges: Array<{
      from_location_id: string
      to_location_id: string
      traversal_condition: string
      condition_detail: string | null
      travel_time_turns: number
    }> = []
    for (const loc of doc.initial_locations) {
      for (const conn of loc.connections) {
        allEdges.push({
          from_location_id: loc.id,
          to_location_id: conn.to_location_id,
          traversal_condition: conn.traversal_condition,
          condition_detail: conn.condition_detail,
          travel_time_turns: conn.travel_time_turns,
        })
      }
    }
    await this.stateStore.set('world:location_edges', allEdges)

    // Faction states
    for (const faction of doc.world_setting.factions) {
      const factionState: FactionState = {
        id: faction.id,
        name: faction.name,
        current_strength: faction.initial_strength,
        current_status_description: faction.description,
        resources_description: faction.initial_resources,
        causal_chain: [],
      }
      await this.stateStore.set(`faction:state:${faction.id}`, factionState)

      // Faction relationships
      for (const [targetId, rel] of Object.entries(faction.initial_relationships)) {
        const factionRel: FactionRelationship = {
          faction_a_id: faction.id,
          faction_b_id: targetId,
          relation_type: rel.relation_type,
          semantic_description: rel.description,
          causal_chain: [],
        }
        await this.stateStore.set(
          `faction:relationship:${faction.id}:${targetId}`,
          factionRel,
        )
      }
    }

    // Game time
    await this.stateStore.set('game:time', { current: { day: 0, hour: 0, turn: 0 }, total_turns: 0 })

    // World tone for EventGenerator pacing
    await this.stateStore.set('world:tone', doc.world_setting.tone)
  }

  private async writeCharacterStates(doc: GenesisDocument): Promise<void> {
    // Player character location
    const startLocation = doc.initial_locations[0]?.id ?? 'unknown'
    await this.stateStore.set(
      `character:location:${doc.characters.player_character.id}`,
      startLocation,
    )

    // Tier A NPCs
    for (const npc of doc.characters.tier_a_npcs) {
      const state: CharacterDynamicState = {
        npc_id: npc.id,
        tier: 'A',
        current_emotion: 'neutral',
        current_location_id: startLocation,
        interaction_count: 0,
        is_active: false,
        goal_queue: [],
      }
      await this.stateStore.set(`character:${npc.id}:state`, state)

      const memoryBuffer: MemoryBuffer = {
        npc_id: npc.id,
        entries: [],
        max_size: 20,
      }
      await this.stateStore.set(`memory:buffer:${npc.id}`, memoryBuffer)

      // Relationships
      for (const [targetId, desc] of Object.entries(npc.initial_relationships)) {
        await this.stateStore.set(`relationship:${npc.id}:${targetId}`, {
          from_npc_id: npc.id,
          to_npc_id: targetId,
          semantic_description: desc,
          strength: 0.5,
          last_updated_event_id: 'genesis',
        })
      }
    }

    // Tier B NPCs
    for (const npc of doc.characters.tier_b_npcs) {
      const state: CharacterDynamicState = {
        npc_id: npc.id,
        tier: 'B',
        current_emotion: 'neutral',
        current_location_id: startLocation,
        interaction_count: 0,
        is_active: false,
        goal_queue: [],
      }
      await this.stateStore.set(`character:${npc.id}:state`, state)

      const memoryBuffer: MemoryBuffer = {
        npc_id: npc.id,
        entries: [],
        max_size: 5,
      }
      await this.stateStore.set(`memory:buffer:${npc.id}`, memoryBuffer)
    }

    // NPC name→id map for resolving LLM state_changes targets
    const nameMap: Record<string, string> = {}
    for (const npc of doc.characters.tier_a_npcs) {
      nameMap[npc.name] = npc.id
    }
    for (const npc of doc.characters.tier_b_npcs) {
      nameMap[npc.name] = npc.id
    }
    await this.stateStore.set('player:npc_name_map', nameMap)
  }

  private async setupNarrativeRail(doc: GenesisDocument): Promise<void> {
    // Store phases for NarrativeRailAgent
    await this.stateStore.set('narrative:phases', doc.narrative_structure.phases)
    await this.stateStore.set('narrative:current_phase_index', 0)
    await this.stateStore.set('narrative:final_goal', doc.narrative_structure.final_goal_description)

    // Map NPCs to phases (simplified: associate all Tier A NPCs with all phases)
    for (const phase of doc.narrative_structure.phases) {
      const phaseNpcIds = doc.characters.tier_a_npcs.map((n) => n.id)
      await this.stateStore.set(`narrative_rail:phase_npcs:${phase.phase_id}`, phaseNpcIds)
    }
  }

  // ---- Step 6: Broadcast Inciting Event ----

  private async broadcastIncitingEvent(doc: GenesisDocument): Promise<void> {
    const inciting = doc.narrative_structure.inciting_event

    const event: Event = {
      id: crypto.randomUUID(),
      title: inciting.title,
      timestamp: { day: 0, hour: 0, turn: 0 },
      location_id: inciting.location_id,
      participant_ids: inciting.participant_ids,
      tags: ['WORLD_CHANGE'],
      weight: 'MAJOR',
      force_level: 0,
      created_at: Date.now(),
      summary: inciting.description,
      choice_signals: {},
      context: inciting.description,
      related_event_ids: [],
      state_snapshot: { location_state: '', participant_states: {} },
      narrative_text: inciting.narrative_text,
    }

    await this.eventStore.append(event)

    // Seed subjective memory and world state for the player character
    const playerId = doc.characters.player_character.id
    const startLoc = doc.initial_locations.find((l) => l.id === inciting.location_id)
    const locationDesc = startLoc ? `${startLoc.name}：${startLoc.description}` : ''

    // Subjective memory: what the player character has experienced
    await this.stateStore.set(`memory:subjective:${playerId}`, {
      recent_narrative: [inciting.narrative_text],
      known_facts: [
        doc.characters.player_character.background,
        `当前位置：${locationDesc}`,
      ],
      known_characters: inciting.participant_ids,
    })

    // Objective world state: what exists in the current scene
    await this.stateStore.set(`world:objective:${playerId}`, {
      current_location: locationDesc,
      scene_description: inciting.narrative_text,
      present_npcs: inciting.participant_ids,
    })

    // World summary for EventContextStep
    await this.stateStore.set(`world:summary:${playerId}`, [
      doc.world_setting.background,
      `当前位置：${locationDesc}`,
      `当前场景：${inciting.narrative_text}`,
    ].join('\n'))

    // Participant states for EventContextStep
    const participantStates = doc.characters.tier_a_npcs
      .filter((n) => inciting.participant_ids.includes(n.id))
      .map((n) => ({ npc_id: n.id, state_summary: `${n.name}：${n.background}` }))
    await this.stateStore.set(`participants:states:${playerId}`, participantStates)

    // Create minimal CharacterKnowledge for NPCs in the inciting event
    // Only record that the player encountered them — actual impressions come from gameplay events
    const allNpcs = [...doc.characters.tier_a_npcs, ...doc.characters.tier_b_npcs]
    for (const npcId of inciting.participant_ids) {
      if (npcId === playerId) continue
      const npcDef = allNpcs.find((n) => n.id === npcId)
      if (!npcDef) continue

      const knowledge: CharacterKnowledge = {
        npc_id: npcId,
        name: npcDef.name,
        first_impression: '',
        known_facts: [],
        relationship_to_player: '',
        last_seen_location: startLoc?.name ?? inciting.location_id,
        last_seen_emotion: '',
        last_interaction_turn: 0,
      }
      await this.stateStore.set(`player:knowledge:${npcId}`, knowledge)
    }

    if (this.eventBus) {
      await this.eventBus.publish({
        id: event.id,
        title: event.title,
        timestamp: event.timestamp,
        location_id: event.location_id,
        participant_ids: event.participant_ids,
        tags: event.tags as import('../models/event.js').EventTier1['tags'],
        weight: event.weight,
        force_level: event.force_level,
        created_at: event.created_at,
      })
    }
  }

  private simpleHash(str: string): string {
    let hash = 5381
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }
}
