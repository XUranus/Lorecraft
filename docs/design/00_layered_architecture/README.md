# 00 分层架构

## 五层定义

### Interface Layer（接口层）

**职责**：系统对外的唯一入口和出口。
- 接收玩家原始文本输入，封装为 `PlayerInput` 对象传入 Orchestration 层
- 接收 Orchestration 层返回的 `NarrativeOutput` 对象，输出给玩家（TUI 渲染等）
- 不含任何游戏逻辑，不直接调用任何 Agent

**包含**：`PlayerInputPort`、`GameOutputPort`

---

### Orchestration Layer（编排层）

**职责**：流程调度，不含游戏规则。
- 实现 Pipeline 主链：决定调用哪些步骤、以什么顺序、传递什么数据
- 管理 EventBus：注册订阅者，路由事件广播
- 管理 AgentScheduler：调度 NPC 自主行动、叙事轨道等异步任务
- **不做游戏判断**：不判断"是否可行"，只编排调用链

**包含**：`MainPipeline`、`EventBus`、`AgentScheduler`、`InjectionQueueManager`

---

### Domain Layer（领域层）

**职责**：游戏业务规则，纯代码，不知道 LLM 的存在。
- 仲裁层的结构化检查逻辑（哪些条件必须满足）
- 信号处理器：特质权重的数值计算（指数衰减、阈值判断）
- 叙事轨道：干预级别的路由决策
- Lore 固化：一致性验证的规则逻辑
- NPC 层级管理：升降级逻辑

**关键约束**：Domain 层通过 `AgentRunner` 接口调用 AI 层，不直接依赖 LLM 实现。
语义判断的"裁决"由 AI 层返回，Domain 层只处理裁决结果的业务逻辑。

**实际实现**：当前各 Pipeline Step 直接持有 `AgentRunner` 引用，通过 `agentRunner.run(messages, options)` 发起 LLM 调用，由 `ResponseParser` + Zod Schema 解析输出。主要 LLM 调用点包括：

| Pipeline Step | LLM 调用 | Prompt 模板 |
|--------------|----------|-------------|
| InputParserStep | 解析意图与原子动作 | `input_parser` |
| VoiceDebateStep | 生成声音台词与辩论（合并调用） | `voice_debate` |
| ActionArbiterStep | 五维可行性判定 + 检定参数 | `action_arbiter` |
| EventGeneratorStep | 生成事件叙事与状态变更 | `event_generator` |
| QuestTrackingStep | 分析任务图变更 | `quest_tracker` |
| NarrativeProgressStep | 评估叙事阶段完成度 | `narrative_progress_assessor` |

**包含**：`ArbitrationService`、`SignalProcessor`、`NarrativeRailService`、`LoreCanonicalizer`、`NPCTierManager`

---

### AI Layer（AI 层）

**职责**：所有 LLM 调用的唯一封装，对上层暴露结构化接口。
- `ContextAssembler`：从多个数据源组装 LLM 输入上下文
- `AgentRunner`：执行 LLM 调用，含重试和超时管理
- `ResponseParser`：将 LLM 输出反序列化为 Domain 对象，执行 Schema 校验
- `PromptRegistry`：管理所有 Prompt 模板，按 Agent 类型索引

**对外接口示例**：
```
IInputParserAI.parse(raw_text, context) → ParsedIntent
IArbitrationAI.judgeNarrativeFeasibility(action, lore_context) → FeasibilityVerdict
INPCResponseAI.generate(npc_state, conversation_context) → NPCResponse
```

**包含**：`AgentRunner`、`ContextAssembler`、`ResponseParser`、`PromptRegistry`

---

### Infrastructure Layer（基础设施层）

**职责**：存储与检索，不含任何业务逻辑。
- `EventStore`：事件不可变存储（追加写）
- `StateStore`：世界状态与角色状态的 KV 存储
- `LoreStore`：Lore 条目与因果链的结构化存储
- `LongTermMemoryStore`：被驱逐的长期记忆条目
- `SessionStore`：存档与创世文档的持久化

**包含**：以上各 Store 及其对应接口定义

---

## 层间通信规则

```
Interface → Orchestration    同步调用，传入 PlayerInput
Orchestration → Domain       同步调用，传入结构化游戏对象
Domain → AI Layer            通过接口调用，传入结构化查询对象
AI Layer → Infrastructure    直接调用（拉取上下文数据）
Orchestration → Infrastructure 直接调用（写入事件、更新状态）
```

**禁止的调用方向**：
- Interface 层不可跳过 Orchestration 直接调用 Domain 或 AI 层
- Domain 层不可直接实例化 LLM 客户端
- Infrastructure 层不可调用任何上层逻辑

---

## 各模块归属层级

| 概念模块 | 所属层 | 说明 |
|---------|--------|------|
| PlayerInputPort | Interface | |
| MainPipeline | Orchestration | 流程编排 |
| EventBus | Orchestration | 异步广播 |
| AgentScheduler | Orchestration | NPC 自主行动调度 |
| ArbitrationService | Domain | 五维可行性判定 + 属性检定 |
| SignalProcessor | Domain | 权重数值计算 |
| NarrativeRailService | Domain | 干预路由决策 |
| LoreCanonicalizer | Domain | 一致性验证规则 |
| NPCTierManager | Domain | 升降级规则 |
| ContextAssembler | AI | LLM 上下文组装 |
| AgentRunner | AI | LLM 调用执行 |
| ResponseParser | AI | 输出解析与校验 |
| PromptRegistry | AI | Prompt 模板管理 |
| EventStore | Infrastructure | 事件持久化 |
| StateStore | Infrastructure | 状态 KV 存储 |
| LoreStore | Infrastructure | Lore 结构化存储 |
| LongTermMemoryStore | Infrastructure | 长期记忆存储 |
| SessionStore | Infrastructure | 存档持久化 |
