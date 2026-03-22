# Phase 5: 集成与初始化

## 目标
实现初始化 Agent、存档系统、扩展点配置接口、端到端集成测试。
Phase 5 完成后，从零输入启动到完整游戏循环的全流程可运行。

**前置依赖**：Phase 1-4

---

## 模块 5.1: 初始化 Agent（InitializationAgent）

### 实现目标
实现 `docs/design/07_initialization_flow/README.md` 中的完整初始化 Pipeline。

### 实现内容

**5.1.1 初始化 Pipeline 6 步实现**

- Step 1：加载游戏作者配置（纯代码）
  - 读取 `style_config`（有默认值，作者可覆盖）
  - 加载自定义 Prompt 覆盖（如有）
  - 默认配置：通用黑色政治惊悚风格，中等复杂度

- Step 2：WorldGenerator LLM 调用
  - 填充 `world_generator_v1.prompt`
  - 单次大型调用，生成完整 `GenesisDocument`
  - 注入 style_config 到 `[IDENTITY]` 区域

- Step 3：创世文档 Schema 校验（ResponseParser）
  - 必填字段完整性检查
  - `tier_a_npcs` 数量 ∈ [3, 7]
  - `narrative_phases` 非空
  - NPC 关系图一致性：A 引用 B → B 的关系中包含 A
  - 叙事阶段连续性：每个 phase 有 `direction_summary`
  - 校验失败 → 附加错误信息重新调用（最多 3 次）

- Step 4：持久化创世文档
  - `SessionStore.saveGenesis(document)`
  - 生成 `genesis_document_id`

- Step 5：分发到各模块（严格顺序）
  - 5a. LoreStore：写入 `AUTHOR_PRESET` 级别的 Lore（世界设定、NPC 档案、势力信息）
  - 5b. StateStore：写入各地点初始状态（`LocationState`）、各势力初始状态（`FactionState`）、地点连通图（`LocationEdge[]`）
  - 5c. 为每个 Tier A/B NPC 创建 `CharacterDynamicState`、`MemoryBuffer`、初始 `RelationshipEntry`
  - 5d. NarrativeRailService：加载叙事结构（`phases` + `final_goal`）
  - 5e. EventStore：写入起始事件（`inciting_event`）
  - 顺序约束：5a → 5c（NPCProfile 依赖 Lore）、5b → 5d（叙事轨道依赖世界状态）、5e 在最后

- Step 6：触发起始事件广播
  - `EventBus.publish(inciting_event.tier1)`
  - 与正常事件广播完全相同流程
  - 游戏正式开始

**5.1.2 创世文档到各模块的数据映射**
- `world_setting.factions` → `FactionState[]` + `FactionRelationship[]`
- `initial_locations` → `LocationState[]` + `LocationEdge[]`（连通图）
- `characters.tier_a_npcs` → `CharacterDynamicState[]`（tier="A"）+ `NPCProfile[]` + `MemoryBuffer[]`（max_size=20）
- `characters.tier_b_npcs` → `CharacterDynamicState[]`（tier="B"）+ `MemoryBuffer[]`（max_size=5）
- `narrative_structure` → NarrativeRailService 初始状态
- `world_setting.hidden_secrets` → `LoreEntry[]`（AUTHOR_PRESET，初始不对玩家可见）

### 验证标准
- 零人类输入启动完整初始化流程
- 创世文档校验拒绝不合规生成结果并重试
- 分发顺序正确（Lore 先于 NPC 状态，世界状态先于叙事轨道）
- 起始事件广播后各消费者正确处理

---

## 模块 5.2: 存档系统（SaveLoadSystem）

### 实现目标
实现 `docs/design/06_storage_and_retrieval/persistence_strategy.md` 中的存档与加载。

### 实现内容

**5.2.1 存档（Save）**
- 序列化 `SaveFile`：
  - `genesis_document_id`（引用，不复制创世文档）
  - `saved_at_turn`
  - `world_state_snapshot`：所有 `LocationState` + `FactionState` + `FactionRelationship` + `GameTime`
  - `all_character_states`：所有 NPC 的 `CharacterDynamicState`
  - `trait_weights`：所有 `TraitWeight`
  - `conversation_histories`：所有活跃 NPC 的 `ConversationHistory`
  - `injection_queues_snapshot`：反思队列 + 各 NPC 队列
- 存档写入 `SessionStore`
- 多存档支持：同一 `genesis_document_id` 可关联多个存档

**5.2.2 加载（Load）**
- 读取 `SaveFile` → 恢复各模块状态：
  1. 加载 `GenesisDocument`（常驻内存）
  2. 恢复 `StateStore` 中所有状态
  3. 恢复 `MemoryBuffer` 和 `ConversationHistory`
  4. 恢复 `TraitWeight`
  5. 恢复注入队列
  6. 重建长期记忆倒排索引（从长期记忆存储重新构建）
- 不重放事件（状态快照已包含完整当前状态）

**5.2.3 重玩同一世界**
- 复用已有 `GenesisDocument`
- 重新执行初始化 Pipeline Step 5（重新初始化各模块状态）
- 创建新 `SaveFile`（指向同一 `genesis_document_id`）

**5.2.4 崩溃恢复**
- 启动时一致性检查：对比 EventStore 最新事件的 `state_changes` 与 StateStore 当前状态
- 事件已写入但状态未更新 → 补充应用 `state_changes`
- 事件未写入 → 本次操作视为未发生

### 验证标准
- 存档后加载，游戏状态完全一致
- 同一创世文档的多存档独立工作
- 崩溃恢复检测不一致并修复

---

## 模块 5.3: 扩展点配置接口

### 实现目标
实现 `docs/design/09_extensibility/README.md` 中的 6 个扩展点。

### 实现内容

**5.3.1 style_config 加载器**
- 读取游戏作者配置：`tone`, `complexity`, `narrative_style`, `player_archetype`
- 提供默认值：通用黑色政治惊悚风格
- 注入到 WorldGenerator 的 `[IDENTITY]` 区域

**5.3.2 Tier C NPC 模板库**
- 从 `config/npc_templates.json` 加载 `TierCTemplate[]`
- 提供默认模板（路人、小贩、守卫等）
- NPC 实例化时从模板库随机选取或按类型匹配

**5.3.3 认知声音配置**
- 从 `config/cognitive_voices.json` 加载声音列表
- 支持禁用某些声音
- 支持覆盖声音描述

**5.3.4 特质配置**
- 从 `config/trait_configs.json` 加载 `TraitConfig[]`
- 支持添加新特质、调整衰减速度和阈值

**5.3.5 叙事风格注入**
- `style_config.narrative_style` 注入到所有叙事生成 Agent 的 `[WORLD_CONTEXT]` 尾部

**5.3.6 AUTHOR_PRESET Lore 接口**
- 实现 `IAuthorTooling`：
  - `presetLore(entries)` → 写入 AUTHOR_PRESET 级别 Lore
  - `listCanonicalizedLore(genesis_id)` → 查看 AI 已固化的事实
- 在初始化之前调用

### 验证标准
- 默认配置可正常启动（零配置）
- 自定义配置正确覆盖默认值
- AUTHOR_PRESET Lore 在 AI 固化中不可覆盖

---

## 模块 5.4: 端到端集成测试

### 验证场景

**场景 A：完整生命周期**
```
1. 零输入初始化 → 创世文档生成 → 各模块初始化
2. 起始事件广播 → NPC 生成主观记忆
3. 玩家输入 → 完整主链 → 叙事输出
4. 事件广播 → 异步消费者全部完成
5. 存档 → 加载 → 状态一致
6. 继续游戏 → 新输入正常处理
```

**场景 B：多轮对话 + NPC 记忆**
```
1. 与 Tier A NPC 对话 3 轮
2. 验证对话历史正确记录
3. 发生涉及该 NPC 的事件
4. 再次对话 → NPC 回复引用之前的事件
5. 验证主观记忆可能与客观事实有偏差
```

**场景 C：NPC 层级升级**
```
1. 与同一 Tier C NPC 交互 3 次
2. 验证升级为 Tier B
3. 验证 MemoryBuffer 创建并包含初始记忆
4. 继续对话 → NPC 引用之前的交互
```

**场景 D：惰性求值**
```
1. 初始化后玩家在地点 A
2. 经过 5 轮交互后移动到地点 B
3. 验证地点 A 被冻结
4. 返回地点 A → 触发补算
5. 验证补算事件标记 INFERRED 并正确写入
```

**场景 E：叙事轨道干预**
```
1. 连续 5 轮输入与主线无关的行动
2. 验证第一级干预：反思注入队列出现内容
3. 继续无关行动 → 验证升级到第二级干预
4. NPC 话题注入出现在下次 NPC 回复中
```

**场景 F：Lore 固化与一致性**
```
1. NPC 在对话中即兴提及一个新事实
2. 验证 FactExtractor 提取该事实
3. 验证 LoreConsistencyChecker 通过
4. 验证 LoreStore 写入 AI_CANONICALIZED 条目
5. 另一个 NPC 提及矛盾事实 → 验证被拒绝或追加因果链
```

**场景 G：崩溃恢复**
```
1. 模拟写入中途崩溃（事件已写入，状态未更新）
2. 重启 → 验证一致性检查检测到问题
3. 验证自动补偿应用 state_changes
4. 继续游戏 → 状态正确
```
