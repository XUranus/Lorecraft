# Phase 4: 异步系统

## 目标
实现 EventBus 完整广播机制、叙事轨道 Agent、Lore 固化模块、二次传播调度。
Phase 4 完成后，事件广播能触发所有异步消费者，叙事轨道能通过三级干预引导玩家，NPC 即兴事实能被固化到 Lore 中。

**前置依赖**：Phase 2（核心 Pipeline）+ Phase 3（Agent 实现）

---

## 模块 4.1: EventBus 完整实现

### 实现目标
将 Phase 2 中 EventPipeline Step 7 的广播占位替换为完整的 EventBus 实现。

### 实现内容

**4.1.1 EventBus 核心**
- 内存内发布/订阅机制（非持久化消息队列）
- 发布者：EventPipeline Step 7（唯一发布入口）
- 发布内容：Event Tier 1（元数据层）
- 订阅者注册表：静态订阅者（世界 Agent、叙事轨道、Lore 固化、广播扩散器）+ 动态订阅者（NPC Agent）
- 所有消费者异步并行执行，不阻塞 Pipeline 主链

**4.1.2 广播路由器（纯代码）**
- 实现 `routeEvent(event: EventTier1, allNpcs: NPC[]): RoutingResult`
  - 直接参与者：无论层级和位置，完整广播
  - Tier A 非参与者：按事件 weight 和地区过滤
  - Tier B 非参与者：仅同一场景内
  - Tier C：不接收广播
- 关系距离判断：`hasStrongRelationship()` 查询 `RelationshipEntry.strength`
- 路由结果分层：`direct_participants` / `tier_a_recipients` / `tier_b_recipients`

**4.1.3 消费者处理框架**
- 每个消费者收到 Tier 1 后：
  - 判断是否需要处理（过滤逻辑）
  - 按需从 EventStore 拉取 Tier 2/3/4
  - 执行 Agent 五步模型
  - 写入自己的状态
- 消费失败处理：
  - 最多重试 3 次（指数退避）
  - 仍失败 → 写入 DeadLetterQueue（`{ event_id, subscriber, error }`）
  - 不影响主链和其他消费者

**4.1.4 DeadLetterQueue 补偿机制**
- NPC/Agent 下次被激活时检查 DeadLetterQueue
- 按时间顺序补偿处理未处理的事件
- 补偿成功 → 从 DeadLetterQueue 移除

**4.1.5 异步完成保证**
- 下一条玩家输入到来前，Pipeline Step 1 前置检查上轮异步任务完成状态
- 若未完成 → 等待（阻塞至异步任务全部完成或超时）

### 验证标准
- 事件广播正确路由到各层级 NPC
- 所有静态消费者（世界 Agent、叙事轨道、Lore 固化）收到事件
- 消费失败写入 DeadLetterQueue，补偿处理正确
- PRIVATE 事件不传播给非参与者

---

## 模块 4.2: 叙事轨道 Agent（NarrativeRailAgent）

### 实现目标
实现 `docs/design/04_event_bus/injection_queues.md` 中的叙事轨道干预系统。

### 实现内容

**4.2.1 偏移评估（DriftAssessor）**
- 触发时机：每次事件广播后（静态订阅 EventBus）
- ContextAssembler：
  - 当前叙事阶段（`NarrativePhase`，从 GenesisDocument 加载）
  - 近期 N 条事件的 Tier 1+2 摘要
  - 当前 `drift_flag` 状态（ArbitrationPipeline Layer 5 设置）
  - 上次干预的 turn 和效果评估
- 填充 `drift_assessor_v1.prompt`
- ResponseParser：输出 `DriftAssessment`（偏移程度 + 是否需要干预 + 建议干预级别）
- 偏移计算逻辑：LLM 自行判断当前事件流与叙事阶段的偏离程度

**4.2.2 三级干预决策**
- 第一级：内心声音注入
  - 条件：偏移轻微，或 `drift_flag = true`
  - 动作：生成 `ReflectionInjection`，写入反思注入队列
  - 填充 `intervention_content_generator_v1.prompt`（voice_type = cognitive voice）
- 第二级：NPC 话题注入
  - 条件：偏移明显，且第一级干预连续 N 轮无效
  - 动作：选择当前场景中的 NPC，生成 `NPCInjection`，写入 NPC 注入队列
  - NPC 选择逻辑：优先选与主线相关的 NPC（纯代码，查 `participant_ids` 与叙事阶段相关的 NPC）
- 第三级：NPC 主动找上门
  - 条件：偏移严重，且前两级干预累计无效
  - 动作：向 EventBus 提交 NPC 自主行动请求，走正常 Pipeline（ArbitrationPipeline + EventPipeline）
  - 选择主线相关 NPC 发起寻找玩家的行动

**4.2.3 注入队列管理器（IInjectionQueueManager）**
- 实现 `enqueueReflection` / `enqueueNPC` / `dequeueReflection` / `dequeueNPC` / `pruneExpired`
- 反思队列：按 priority 排序，同优先级按创建时间排序
- NPC 队列：同一 NPC 多条注入时合并 context 字段
- 过期清理：`AgentScheduler` 定期调用 `pruneExpired(current_turn)`

**4.2.4 干预效果评估**
- LLM 自行判断上次干预是否有效（注入 `drift_assessor_v1.prompt` 的上下文中）
- 不需要独立的评估 Agent
- 效果评估影响下一轮的干预级别决策

### 验证标准
- 偏移评估能正确检测玩家偏离主线
- 第一级干预：反思注入队列中出现内容，ReflectionPipeline 能消费
- 第二级干预：NPC 注入队列中出现内容，NPC 回复引用注入话题
- 第三级干预：NPC 自主行动事件生成
- 注入队列过期清理正常
- 叙事轨道 Agent 不直接修改任何游戏状态（仅通过队列间接影响）

---

## 模块 4.3: Lore 固化模块（LoreCanonicalizer）

### 实现目标
实现事实提取、一致性验证和 Lore 写入。

### 实现内容

**4.3.1 事实提取（FactExtractor）**
- 触发时机：EventBus 广播后（静态订阅）
- 输入：Event Tier 4（叙事原文）
- 填充 `fact_extractor_v1.prompt`
- ResponseParser：输出 `ExtractedFact[]`，每条含 `content`, `fact_type`, `subject_ids`, `confidence`
- 仅对 NPC 对话中的新信息提取（非重复已知事实）

**4.3.2 一致性验证（LoreConsistencyChecker）**
- 对每条 `ExtractedFact`：
  - 查询 LoreStore 中该 `subject_id` 的现有 Lore（按 content_hash 去重）
  - 查询语义相似的 Lore（`LoreStore.semanticQuery`）
  - 填充 `lore_consistency_checker_v1.prompt`
  - LLM 判断：与现有 Lore 一致 / 补充 / 矛盾
- 处理结果：
  - 一致/补充 → 写入 LoreStore（`authority_level = "AI_CANONICALIZED"`）
  - 矛盾 + 现有为 `AUTHOR_PRESET` → 丢弃新事实（作者预设不可覆盖）
  - 矛盾 + 现有为 `AI_CANONICALIZED` → 追加因果链条目（`LoreCausalEntry`），更新 content
- 第一声明原则：NPC 首次提到的信息，在无矛盾时直接固化

**4.3.3 Lore 写入与同步**
- 写入 LoreStore（含 `causal_chain` 追加）
- 同步更新相关 NPC 的 `NPCProfile` 本地缓存

**4.3.4 content_hash 幂等写入**
- 对 `ExtractedFact.content` 计算 hash
- 查询 `LoreStore.findByContentHash` → 若已存在则跳过
- 防止同一事实因重试或补偿被重复写入

### 验证标准
- NPC 对话中的新事实被正确提取
- 与 AUTHOR_PRESET Lore 矛盾的事实被丢弃
- AI_CANONICALIZED Lore 的因果链正确追加
- NPCProfile 缓存同步更新
- 幂等写入：重复事实不产生重复条目

---

## 模块 4.4: 二次传播（PropagationScheduler）

### 实现目标
实现信息在 NPC 之间的延迟扩散。

### 实现内容

**4.4.1 广播扩散器（EventBus 订阅者）**
- 触发条件：`event.weight >= "SIGNIFICANT"`
- 计算扩散计划：
  - 目标：与 participants 有间接关系的 NPC（关系距离 = 2）
  - 间接关系查询：遍历 `RelationshipEntry`，找到 participant 的关系人的关系人
  - 排除已在首次广播中接收的 NPC
- 延迟计算（纯代码）：
  - `SIGNIFICANT` 事件：1-2 turns 延迟
  - `MAJOR` 事件：0-1 turns 延迟
- 传播内容：仅 Tier 2 摘要（不传播原文）

**4.4.2 PropagationSchedule 持久化**
- 写入 StateStore（key: `propagation:schedule`）
- 数据结构：`{ event_id, target_npc_id, deliver_at_turn, tier2_summary }`
- `AgentScheduler` 每轮检查到期的传播计划

**4.4.3 传播执行**
- 到期 → 将 Tier 2 摘要写入目标 NPC 的待注入队列（作为 `NPCInjection`，context = "你听说了……"）
- NPC 下次被激活时，将此信息作为"听说了什么事"处理
- NPC Agent 的主观过滤自然产生失真（不需要专门建模）

### 验证标准
- SIGNIFICANT 以上事件触发扩散计划
- 扩散在正确的 turn 延迟后执行
- 目标 NPC 的注入队列收到传播内容
- 已接收首次广播的 NPC 不会重复接收

---

## 模块 4.5: AgentScheduler 完整实现

### 实现内容

**4.5.1 调度任务整合**
将 Phase 3 的基础调度器扩展为完整版本，统一管理所有异步任务：
- NPC 自主意图调度（Phase 3 已实现）
- 二次传播到期检查（Phase 4 新增）
- NPC 层级升降级检查（Phase 3 已实现）
- 注入队列过期清理（Phase 4 新增）
- DeadLetterQueue 补偿检查（Phase 4 新增）

**4.5.2 执行顺序**
每轮结束后按以下顺序执行：
1. DeadLetterQueue 补偿（确保上轮失败的异步任务优先处理）
2. 二次传播到期执行
3. NPC 自主意图调度
4. NPC 层级升降级检查
5. 注入队列过期清理

### 验证标准
- 所有异步任务按正确顺序执行
- 各任务之间不互相干扰
