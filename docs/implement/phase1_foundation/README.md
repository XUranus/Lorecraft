# Phase 1: 基础设施层

## 目标
实现 Infrastructure 层全部存储接口 + AI 层核心运行时。
Phase 1 完成后，可以独立运行存储操作和 LLM 调用，但没有游戏逻辑。

---

## 模块 1.1: 存储接口与实现

### 实现目标
实现 `docs/design/06_storage_and_retrieval/README.md` 中定义的所有存储接口。

### 实现内容

**1.1.1 EventStore**
- 实现 `IEventStore` 接口：`append`, `getTier1`, `getTiers`, `scanByTimeRange`, `scanByParticipant`
- 事件按 Tier 分片存储（四个独立存储键）
- 追加写模式，写入后不可修改/删除
- 写入时检查 event_id 幂等性（重复写入静默忽略）
- 数据结构：`docs/design/04_event_bus/event_schema.md`
- 首版实现：内存 + JSON 文件持久化（后续可替换为数据库）

**1.1.2 StateStore**
- 实现 `IStateStore` 接口：`get<T>`, `set<T>`
- KV 存储，key 遵循命名空间规范（`world:location:{id}`, `character:{npc_id}:state` 等）
- 支持按命名空间前缀批量查询
- 首版实现：内存 HashMap + JSON 快照

**1.1.3 LoreStore**
- 实现 `ILoreStore` 接口：`append`, `findBySubject`, `findByContentHash`
- 数据结构：`docs/design/05_data_models/lore_schema.md`
- 因果链（`causal_chain`）存储为数组字段，只增不删
- 首版不实现语义检索，按 `subject_ids` 精确匹配 + `fact_type` 过滤

**1.1.4 长期记忆存储**
- MemoryBuffer 溢出条目的持久化存储（Tier A NPC 专属）
- 按 `participant_ids` 和 `location_id` 建立倒排索引
- 按 `recorded_at_turn` 时间倒序查询
- 首版实现：内存 + JSON 持久化

**1.1.5 SessionStore**
- 创世文档的持久化与读取
- 存档（SaveFile）的序列化/反序列化
- 数据结构：`docs/design/06_storage_and_retrieval/persistence_strategy.md`

### 验证标准
- 可以写入/读取所有类型的数据
- Event 的幂等写入正确
- LoreStore 按 subject_id 查询正确
- 长期记忆按 participant_id 过滤 + 时间倒序查询正确
- 命名空间隔离工作正常

---

## 模块 1.2: AI 层核心运行时

### 实现目标
实现 `docs/design/02_agent_internals/README.md` 中的 AgentRunner + ResponseParser 框架。

### 实现内容

**1.2.1 AgentRunner**
- 统一的 LLM 调用执行器
- 封装：API 调用 → 超时控制 → 指数退避重试（最多 3 次）
- 每次调用记录日志：`LLMCallLog`（见 `docs/design/08_error_handling/README.md`）
- LLM Provider 可插拔（首版支持一种 API 即可）
- 支持 structured output / function calling（如果模型支持）

**1.2.2 ResponseParser 框架**
- 泛型 Parser 基类，实现 `IResponseParser<T>` 接口
- JSON 反序列化 + Schema 校验
- 错误分类：`INVALID_JSON`, `SCHEMA_VIOLATION`, `ENUM_VIOLATION`, `SEMANTIC_CONFLICT`
- 可重试错误的附加提示生成（自动将错误信息注入下次调用）

**1.2.3 PromptRegistry**
- Prompt 模板文件的加载与索引
- 按 `{agent_type}_{call_name}` 查找模板
- 占位符替换机制（将 ContextAssembler 输出填入四区结构）

**1.2.4 ContextAssembler 框架**
- 实现 `IContextAssembler` 接口
- Token 预算管理器（计算各区域预算，按优先级截断）
- Token 计数器（支持主流 tokenizer）
- 各数据源的拉取接口定义（实际数据源在 Phase 2/3 中接入）

### 验证标准
- AgentRunner 可以成功调用 LLM API 并返回文本
- ResponseParser 可以正确解析合法 JSON 并拒绝非法 JSON
- 重试机制在模拟错误时正确触发
- PromptRegistry 可以加载模板并替换占位符

---

## 模块 1.3: 基础数据模型

### 实现目标
将 `docs/design/05_data_models/` 中的所有 Schema 实现为代码中的类型定义。

### 实现内容

- `Event` 及其 Tier 1-4 分层类型
- `LocationState`, `FactionState`, `LocationEdge` 及连通性图
- `CharacterDynamicState`, `RelationshipEntry`, `MemoryBuffer`
- `LoreEntry`, `LoreCausalEntry`
- `TraitWeight`, `TraitConfig`
- `GenesisDocument` 及其所有子类型
- `GameTimestamp`, `GameTime`
- 所有枚举类型（`EventWeight`, `EventTag`, `TraitType`, `TraitStatus` 等）
- 各类型的校验函数（用于 ResponseParser）

### 验证标准
- 所有类型可以正确序列化/反序列化 JSON
- 枚举值校验正确

---

## 首批 Prompt 模板

### 需要在 Phase 1 中创建的 Prompt 模板（空壳 + 四区结构骨架）

```
prompts/
├── input_parser_v1.prompt
├── ambiguity_resolver_v1.prompt
├── trait_voice_generator_v1.prompt
├── debate_generator_v1.prompt
├── narrative_feasibility_judge_v1.prompt
├── rejection_narrative_generator_v1.prompt
├── event_generator_v1.prompt
├── signal_b_tagger_v1.prompt
├── npc_response_generator_v1.prompt
├── subjective_memory_generator_v1.prompt
├── npc_intent_generator_v1.prompt
├── lazy_eval_inference_v1.prompt
├── drift_assessor_v1.prompt
├── intervention_content_generator_v1.prompt
├── fact_extractor_v1.prompt
├── lore_consistency_checker_v1.prompt
└── world_generator_v1.prompt
```

Phase 1 只创建骨架（四区结构标记 + 占位符），实际内容在各 Phase 中逐步填充。
