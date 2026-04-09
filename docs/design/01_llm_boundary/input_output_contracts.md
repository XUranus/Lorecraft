# LLM 调用结构化 I/O 规范

每个 LLM 调用单元的文档格式：
- **名称**：调用标识符
- **触发方**：哪个 Domain 模块发起
- **输入**：传入 LLM 的结构化上下文字段
- **输出**：LLM 返回的 JSON Schema
- **调用频率**：每次玩家输入触发 N 次

---

## 输入层

### `InputParser`
**触发方**：MainPipeline Step 1
**输入**：
```json
{
  "raw_text": "string",
  "character_location": "string",
  "character_known_npcs": ["string"],
  "recent_events_summary": ["string"],
  "current_scene_description": "string"
}
```
**输出**：
```json
{
  "intent": "string",
  "tone_signals": {
    "sarcasm": 0.0,
    "hostility": 0.0,
    "playfulness": 0.0,
    "romantic": 0.0,
    "contempt": 0.0
  },
  "atomic_actions": [
    {
      "type": "MOVE_TO | SPEAK_TO | EXAMINE | GIVE | CONFRONT | ...",
      "target": "string | null",
      "method": "string | null",
      "order": 0
    }
  ],
  "ambiguity_flags": ["string"]
}
```

### `AmbiguityResolver`
**触发方**：MainPipeline Step 2（仅当 `ambiguity_flags` 非空时）
**输入**：
```json
{
  "ambiguous_action": { "...action object..." },
  "ambiguity_reason": "string",
  "game_context": "string"
}
```
**输出**：
```json
{
  "resolved_method": "string",
  "confidence": 0.0
}
```

---

## 反思系统

### `VoiceDebate`（合并调用）
**触发方**：VoiceDebateStep（反思阶段 Step 4）
**说明**：原先的 TraitVoiceGenerator 和 DebateGenerator 已合并为单次 LLM 调用
**Prompt**：`voice_debate`
**输入**：
```json
{
  "active_traits": [
    { "trait_id": "string", "weight": 0.0, "type": "EXPRESSION | VALUE" }
  ],
  "intent_summary": "string",
  "character_state_summary": "string",
  "injected_context": "string | null"
}
```
**输出**：
```json
{
  "voices": [
    { "trait_id": "string", "line": "string" }
  ],
  "debate_lines": [
    { "trait_id": "string", "line": "string" }
  ]
}
```

---

## 仲裁层

### `ActionArbiter`（合并调用）
**触发方**：ActionArbiterStep（仲裁阶段 Step 2）
**说明**：原先的 NarrativeFeasibilityJudge 和 RejectionNarrativeGenerator 已合并为单次 LLM 调用，同时包含属性检定判断
**Prompt**：`action_arbiter`
**输入**：
```json
{
  "action": { "type": "string", "target": "string | null", "method": "string | null" },
  "subjective_memory": { "..." },
  "objective_world_state": { "..." },
  "lore_context": ["..."],
  "recent_events": ["..."],
  "narrative_direction": "string",
  "world_tone": "string"
}
```
**输出**：
```json
{
  "passed": true,
  "checks": [
    { "dimension": "string", "passed": true, "reason": "string | null" }
  ],
  "drift_flag": false,
  "rejection_narrative": "string | null",
  "needs_check": false,
  "attribute": "string | null",
  "difficulty": "TRIVIAL | ROUTINE | HARD | VERY_HARD | LEGENDARY | null",
  "modifiers": [{ "label": "string", "value": 0 }],
  "check_reason": "string | null"
}
```
d100 属性检定由代码执行（非 LLM），LLM 仅判断是否需要检定及其参数。

---

## 事件 Agent

### `EventGenerator`
**触发方**：EventGeneratorStep（事件阶段 Step 2）
**Prompt**：`event_generator`
**输入**：
```json
{
  "action": { "...action object..." },
  "force_flag": false,
  "force_level": 0,
  "world_tone": "string",
  "world_state_summary": "string",
  "participants_state": [
    { "npc_id": "string", "state_summary": "string" }
  ],
  "recent_narrative": ["string"],
  "known_facts": ["string"],
  "attribute_check": { "needed": true, "passed": true, "..." },
  "narrative_direction": "string",
  "beat_plan": "string | null"
}
```
**输出**：
```json
{
  "title": "string",
  "tags": ["string"],
  "weight": "PRIVATE | MINOR | SIGNIFICANT | MAJOR",
  "summary": "string",
  "context": "string",
  "narrative_text": "string",
  "state_changes": [
    { "target": "string", "field": "string", "change_description": "string" }
  ],
  "character_observations": [
    { "npc_name": "string", "observation": "string", "relationship_hint": "string | null" }
  ],
  "choices": [
    { "text": "string", "check": { "attribute_id": "string", "difficulty": "string" } | null }
  ]
}
```
每次固定生成 2 个后续选项。character_observations 用于更新玩家对 NPC 的认知。

### `QuestTracker`
**触发方**：QuestTrackingStep（事件阶段 Step 7，非关键）
**Prompt**：`quest_tracker`
**输入**：
```json
{
  "event": { "title": "string", "summary": "string", "tags": ["string"], "narrative_text": "string", "state_changes": ["..."] },
  "current_quest_graph": { "quests": ["..."], "nodes": ["..."], "edges": ["..."] },
  "turn": 0
}
```
**输出**：
```json
{
  "new_quests": [{ "id": "string", "title": "string" }],
  "new_nodes": [{ "id": "string", "quest_id": "string", "summary": "string", "hint": "string" }],
  "new_edges": [{ "from_node_id": "string", "to_node_id": "string" }],
  "completed_nodes": ["node_id"],
  "failed_nodes": ["node_id"],
  "completed_quests": ["quest_id"],
  "failed_quests": ["quest_id"]
}
```
大多数回合输出空 delta。失败时静默跳过，不影响主流程。

### `SignalBTagger`（条件触发，当前未接入主 Pipeline）
**说明**：代码实现存在（SignalBStep），但当前未添加到 buildMainPipeline() 中
**Prompt**：`signal_b_tagger`
**输出**：
```json
{
  "choice_signals": {
    "ruthless": 0.0,
    "impulsive": 0.0,
    "empathy": 0.0
  }
}
```

---

## 角色 Agent（NPC）

### `NPCResponseGenerator`
**触发方**：NPCAgent.respond()
**输入**：
```json
{
  "npc_profile_summary": "string",
  "npc_current_state": "string",
  "relationship_to_player": "string",
  "conversation_history": ["string"],
  "injected_narrative_hint": "string | null",
  "recent_memory_snippets": ["string"]
}
```
**输出**：
```json
{
  "response_text": "string",
  "emotion_change": "string | null",
  "relationship_change_signal": "string | null"
}
```

### `SubjectiveMemoryGenerator`
**触发方**：NPCAgent（收到事件广播后，Tier A）
**输入**：
```json
{
  "event_summary": "string",
  "npc_profile_summary": "string",
  "npc_current_emotion": "string",
  "prior_beliefs_relevant": ["string"],
  "relationship_to_participants": "string"
}
```
**输出**：
```json
{
  "subjective_summary": "string",
  "distortion_type": "NONE | INFO_GAP | INTENT_MISREAD | EMOTIONAL_DISTORTION | null"
}
```

### `NPCIntentGenerator`
**触发方**：AgentScheduler（Tier A NPC 自主行动）
**输入**：
```json
{
  "npc_profile_summary": "string",
  "current_goal": "string",
  "relevant_world_state": "string",
  "recent_memory_snippets": ["string"]
}
```
**输出**：
```json
{
  "intent": "string",
  "atomic_actions": ["...action objects..."]
}
```

---

## 世界 Agent

### `LazyEvalInference`
**触发方**：WorldAgent（惰性求值补算）
**输入**：
```json
{
  "location_id": "string",
  "last_observed_state": "string",
  "elapsed_game_time": "string",
  "relevant_global_events": ["string"],
  "npc_goals_at_freeze": ["string"],
  "npc_tier": "A | B"
}
```
**输出**：
```json
{
  "inferred_events": [
    {
      "title": "string",
      "summary": "string",
      "state_changes": ["string"]
    }
  ],
  "current_state_description": "string"
}
```

---

## 叙事轨道 Agent

### `DriftAssessor`
**触发方**：NarrativeRailService（异步，持续运行）
**输入**：
```json
{
  "narrative_structure_summary": "string",
  "recent_event_summaries": ["string"],
  "last_intervention": { "level": 0, "turns_ago": 0 }
}
```
**输出**：
```json
{
  "intervention_needed": false,
  "intervention_level": 0,
  "reason": "string"
}
```

### `InterventionContentGenerator`
**触发方**：NarrativeRailService（干预决定后）
**输入**：
```json
{
  "intervention_level": 1,
  "narrative_structure_summary": "string",
  "target_npc_profile": "string | null",
  "current_scene": "string"
}
```
**输出**：
```json
{
  "content": "string",
  "voice_id": "string | null",
  "npc_hint_condition": "string | null"
}
```

---

## Lore 固化

### `FactExtractor`
**触发方**：LoreCanonicalizer（NPC 回复生成后）
**输入**：
```json
{
  "npc_response_text": "string",
  "npc_id": "string",
  "existing_npc_lore_summary": "string"
}
```
**输出**：
```json
{
  "extracted_facts": [
    {
      "content": "string",
      "fact_type": "NPC_PERSONAL | WORLD | RELATIONSHIP | ORGANIZATION",
      "confidence": 0.0,
      "is_new": true
    }
  ]
}
```

### `LoreConsistencyChecker`
**触发方**：LoreCanonicalizer（写入前验证）
**输入**：
```json
{
  "new_fact": "string",
  "related_existing_lore": ["string"]
}
```
**输出**：
```json
{
  "has_conflict": false,
  "conflict_description": "string | null",
  "conflicting_lore_id": "string | null"
}
```

---

## 初始化 Agent

### `WorldGenerator`
**触发方**：InitializationPipeline（游戏启动时，仅一次）
**输入**：
```json
{
  "style_config": {
    "tone": "string",
    "complexity": "LOW | MEDIUM | HIGH",
    "narrative_style": "string"
  }
}
```
**输出**：见 [07_initialization_flow/README.md](../07_initialization_flow/README.md) 中的创世文档 Schema。
