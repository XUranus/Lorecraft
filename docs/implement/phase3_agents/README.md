# Phase 3: Agent 实现

## 目标
实现角色 Agent（NPC 回复、主观记忆、自主意图）和世界 Agent（状态管理、惰性求值）。
Phase 3 完成后，NPC 能基于记忆和性格进行对话回复，世界状态能随事件更新，冻结区域能在观测时补算。

**前置依赖**：Phase 2（核心 Pipeline）

---

## 模块 3.1: NPC 回复系统（NPCResponseGenerator）

### 实现目标
实现 NPC 在对话场景下的回复生成，遵循 `docs/design/02_agent_internals/README.md` 的五步模型。

### 实现内容

**3.1.1 NPCResponseGenerator 五步实现**
- PromptTemplate：填充 `npc_response_generator_v1.prompt`
- ContextAssembler：
  - 数据源 1：NPC 档案（`NPCProfile`，从 LoreStore 本地缓存读取）
  - 数据源 2：对话历史（`ConversationHistory`，按 `max_turns` 截断）
  - 数据源 3：近期记忆缓冲（`MemoryBuffer`，按时间排序取最新 N 条）
  - 数据源 4：长期记忆召回（仅 Tier A，按 participant_id 过滤 + 时间倒序 top-5）
  - 数据源 5：NPC 待注入队列（`IInjectionQueueManager.dequeueNPC`，最高优先级注入）
  - 数据源 6：当前情感状态（`CharacterDynamicState.current_emotion`）
  - Token 预算管理：按 `docs/design/02_agent_internals/context_assembler.md` 的优先级截断
- ResponseParser：校验 NPCResponse Schema（回复文本 + 情感变化信号）
- StateUpdate：
  - 更新 `CharacterDynamicState.current_emotion`
  - 追加对话历史（双方各一条 `ConversationTurn`）
  - 递增 `interaction_count`
  - 消费已使用的 NPC 待注入队列条目

**3.1.2 按 Tier 分层的回复策略**
- Tier A：完整五步（含长期记忆检索 + 目标队列感知 + 待注入队列）
- Tier B：简化五步（无长期记忆，仅近期记忆缓冲 + 待注入队列，无目标队列）
- Tier C：从 `TierCTemplate` 实例化，注入 personality_sketch 到 System Prompt，对话后状态丢弃
- 分层路由器：根据 `CharacterDynamicState.tier` 选择对应策略

### 验证标准
- Tier A NPC 回复引用长期记忆中的事件
- Tier B NPC 回复基于近期交互
- Tier C NPC 回复符合模板人格，不保留跨对话状态
- 待注入队列内容被正确消费并影响回复

---

## 模块 3.2: 主观记忆生成（SubjectiveMemoryGenerator）

### 实现目标
实现 `docs/design/01_llm_boundary/input_output_contracts.md` 中的 SubjectiveMemoryGenerator LLM 调用单元。

### 实现内容

**3.2.1 SubjectiveMemoryGenerator 五步实现**
- 触发时机：EventBus 广播后，相关 NPC Agent 接收到事件
- ContextAssembler：
  - 事件的 Tier 1+2+3+4（Tier A）或 Tier 1+2（Tier B）
  - NPC 当前情感状态和人格描述
  - NPC 与事件参与者的关系（`RelationshipEntry.semantic_description`）
- 填充 `subjective_memory_generator_v1.prompt`
- ResponseParser：校验输出包含 `subjective_summary` 和 `distortion_type`
- StateUpdate：
  - 写入 `MemoryBuffer`（追加 `MemoryBufferEntry`）
  - 若 MemoryBuffer 溢出（超过 `max_size`）：
    - Tier A：将最旧条目写入长期记忆存储（按 participant_ids 和 location_id 建倒排索引）
    - Tier B：直接丢弃最旧条目

**3.2.2 扭曲类型生成**
- LLM 根据 NPC 性格和情感状态决定扭曲类型：
  - `NONE`：客观记忆
  - `INFO_GAP`：信息缺失（NPC 不在场时的事件）
  - `INTENT_MISREAD`：意图误读（NPC 对他人动机的错误推断）
  - `EMOTIONAL_DISTORTION`：情感失真（NPC 因情感偏见扭曲记忆）
- 扭曲体现在 `subjective_summary` 的文本内容中，代码不做额外处理

### 验证标准
- 同一事件，不同 NPC 生成不同的主观摘要
- MemoryBuffer 溢出时正确触发长期记忆写入（Tier A）或丢弃（Tier B）
- 扭曲类型与 NPC 性格/关系一致

---

## 模块 3.3: NPC 自主意图（NPCIntentGenerator）

### 实现目标
实现 NPC 自主行动的意图生成，复用 ArbitrationPipeline + EventPipeline。

### 实现内容

**3.3.1 NPCIntentGenerator 五步实现**
- 触发时机：`AgentScheduler` 在 NPC 目标队列中有 `IN_PROGRESS` 目标时触发（仅 Tier A）
- ContextAssembler：
  - NPC 目标队列（`GoalQueueEntry`，按优先级排序）
  - NPC 当前位置和周围状态
  - NPC 近期记忆
  - 当前世界时间
- 填充 `npc_intent_generator_v1.prompt`
- ResponseParser：输出 `AtomicAction[]`（与玩家输入解析结果同结构）
- StateUpdate：无直接状态写入，将 action 送入 ArbitrationPipeline

**3.3.2 NPC 行动 Pipeline**
- NPC 意图直接进入 ArbitrationPipeline（跳过 InputPipeline 和 ReflectionPipeline）
- ArbitrationPipeline + EventPipeline 复用 Phase 2 已实现的逻辑
- 生成的事件标记 `source: "NPC"` 以区分于玩家触发的事件
- 事件广播流程与玩家行动完全一致

**3.3.3 AgentScheduler 基础实现**
- 每轮结束后检查所有 Tier A NPC 的 `goal_queue`
- 筛选条件：`status = "IN_PROGRESS"` 且 NPC 不在当前对话中（`is_active = false`）
- 排队执行（非并行，避免事件冲突）
- Phase 3 仅实现基础调度，Phase 4 扩展为包含二次传播等异步任务

### 验证标准
- Tier A NPC 能根据目标队列生成自主行动
- NPC 行动经过仲裁检查（不可行的行动被正确拒绝）
- NPC 行动产生的事件正确广播给相关 NPC

---

## 模块 3.4: 世界 Agent（WorldAgent）

### 实现目标
实现世界状态的客观更新逻辑和惰性求值机制。

### 实现内容

**3.4.1 世界状态更新（EventBus 订阅者）**
- 订阅所有 EventBus 事件（静态订阅）
- 读取事件 Tier 1+2，提取 `state_changes`
- 应用状态变更到 StateStore：
  - 地点状态更新（`LocationState`，含 `causal_chain` 追加）
  - 势力状态更新（`FactionState`，含 `causal_chain` 追加）
  - NPC 粗粒度位置更新（`NPCRoughLocation`）
  - 关系图谱更新（`RelationshipEntry`）
  - 游戏时间推进（`GameTime.total_turns++`）
- 所有写入幂等（`event_id` 去重）

**3.4.2 惰性求值实现**
- 触发检测：`checkAndEvaluate(target_id, target_type)` —— 纯代码
  - 检查 `is_frozen` 标记和 `last_observed_turn`
  - 若冻结且有经过的 turn → 启动补算
- 补算流程（6 步，见 `docs/design/06_storage_and_retrieval/lazy_evaluation_design.md`）：
  - Step 1：读取冻结快照
  - Step 2：扫描期间全局重大事件（`EventStore.scanByTimeRange`，过滤 weight >= SIGNIFICANT）
  - Step 3：查询相关 Tier A NPC 的目标队列
  - Step 4：LazyEvalInference LLM 调用 → 填充 `lazy_eval_inference_v1.prompt`
  - Step 5：将推断事件走完整 EventPipeline（标记 `INFERRED` tag）
  - Step 6：更新冻结状态（`is_frozen = false, last_observed_turn = current`）
- 按 NPC Tier 分层：
  - Tier A：完整补算（目标队列 + 全局事件）
  - Tier B：简化补算（仅全局事件）
  - Tier C：跳过补算，重置为默认状态
- 并发锁：同一 target 的补算不可并行（`evaluationLocks` Map）

**3.4.3 冻结与解冻**
- 玩家离开地点或结束对话 → `freezeTarget()`：设置 `is_frozen = true`
- 玩家进入地点或开始交互 → `checkAndEvaluate()` 触发补算后解冻
- 当前所在地点和正在对话的 NPC 始终非冻结

### 验证标准
- 事件广播后世界状态正确更新（地点、势力、关系）
- 冻结区域在玩家进入时触发补算
- 补算生成的 INFERRED 事件正确写入 EventStore 并广播
- 并发锁防止同一区域重复补算

---

## 模块 3.5: NPC 层级管理（NPCTierManager）

### 实现目标
实现 `docs/design/05_data_models/character_state_schema.md` 中的升降级逻辑。

### 实现内容

**3.5.1 升级逻辑**
- C → B 升级：
  - 触发条件：`interaction_count >= TIER_C_TO_B_THRESHOLD`（默认 3）
  - 执行动作：
    - `tier = "B"`
    - 创建 `MemoryBuffer`（`max_size = 5`）
    - 最近 3 次交互的 `ConversationHistory` 生成摘要写入初始记忆
    - 创建 `CharacterDynamicState` 持久化
- B → A 升级：仅由叙事事件或游戏作者配置触发（不自动升级）
  - 预留接口：`promoteTierA(npc_id, initial_goals: GoalQueueEntry[])`

**3.5.2 降级逻辑**
- B → B-lite（轻量模式）：
  - 触发条件：`current_turn - last_interaction_turn > TIER_B_INACTIVE_THRESHOLD`（默认 50）
  - 执行动作：压缩记忆为单条摘要（`compressMemoryToSummary`）
  - `tier` 字段仍为 `"B"`，内部标记为 lite 模式
  - B-lite 被再次交互时自动恢复完整模式
- Tier A 不降级

**3.5.3 阈值可配置**
- 所有阈值从配置文件读取，游戏作者可覆盖
- 在 `AgentScheduler` 每轮结束时检查所有 NPC 的升降级条件

### 验证标准
- C → B 升级后 NPC 拥有记忆缓冲
- B-lite 模式下 NPC 记忆被压缩为单条摘要
- B-lite 被交互后恢复完整模式
- 阈值可通过配置覆盖

---

## 模块 3.6: 对话历史管理

### 实现内容

**3.6.1 ConversationHistory 的读写**
- 每次 NPC 回复后追加双方各一条 `ConversationTurn`
- 超过 `max_turns` 时从中间压缩（保留首尾，压缩中间段为摘要）
- 压缩由代码执行，不调用 LLM

**3.6.2 长期记忆写入**
- 仅 Tier A NPC
- `MemoryBuffer` 溢出条目 → 写入长期记忆存储
- key: `memory:long_term:{npc_id}:{event_id}`
- 维护 participant_id 和 location_id 倒排索引

### 验证标准
- 对话历史按 `max_turns` 正确截断
- Tier A 的长期记忆可通过 participant_id 过滤检索
