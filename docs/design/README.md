# CRPG 引擎技术架构设计

> 本文件夹是工程实现细节的补充参考。
> 主文档见 `docs/architecture/`（概念设计 + Pipeline 流程）。
> 本文件夹聚焦于"代码层面如何实现"的细节，如分层规则、Agent 内部结构、数据模型定义等。

---

## 核心技术原则

1. **LLM 只处理语义，代码处理一切逻辑**
   LLM 接收结构化输入，返回结构化输出。流程控制、路由、状态写入全部由代码执行。

2. **Agent 之间不直接互调**
   所有 Agent 通过 Pipeline（同步）或 EventBus（异步）通信，不持有彼此的引用。

3. **每个 Agent = 五步模型**
   `PromptTemplate → ContextAssembler → LLM Call → ResponseParser → StateUpdate`

4. **主链阻塞，副链异步**
   玩家输入走阻塞式 Pipeline，叙事轨道 / Lore 固化 / 二次广播走异步 EventBus。

5. **事件不可变，状态单向增长**
   事件写入后只读。世界只向前运动。

---

## 五层架构

```
┌─────────────────────────────────────────────────┐
│                 Interface Layer                  │
│         PlayerInputPort / GameOutputPort         │
│         接收玩家输入，输出叙事文本，不含业务逻辑        │
├─────────────────────────────────────────────────┤
│               Orchestration Layer                │
│       Pipeline / EventBus / AgentScheduler       │
│       流程调度，不含游戏规则，不直接调用 LLM           │
├─────────────────────────────────────────────────┤
│                  Domain Layer                    │
│   Arbitration / SignalProcessor / NarrativeRail  │
│       游戏业务规则，纯代码，不知道 LLM 的存在           │
├─────────────────────────────────────────────────┤
│                   AI Layer                       │
│     AgentRunner / ContextAssembler / Parser      │
│     LLM 调用的唯一封装层，对外暴露结构化接口           │
├─────────────────────────────────────────────────┤
│              Infrastructure Layer                │
│   EventStore / StateStore / VectorStore / Cache  │
│          存储与检索，不含任何业务逻辑                  │
└─────────────────────────────────────────────────┘
```

层间规则：**上层只调用下层，禁止跨层，禁止下层调用上层。**
领域层通过接口隔离感知 AI 层（不直接依赖 LLM 实现）。

---

## 模块目录

| 文档 | 内容 |
|------|------|
| [00 分层架构](./00_layered_architecture/README.md) | 层定义、层间通信契约、模块归属 |
| [01 LLM 边界](./01_llm_boundary/README.md) | LLM 与代码职责划分、结构化 I/O 规范、Prompt 规范 |
| [02 Agent 内部结构](./02_agent_internals/README.md) | 五步模型、ContextAssembler、Parser、StateUpdate |
| [03 Pipeline 设计](./03_pipeline_design/README.md) | 主链设计、各子 Pipeline（输入/反思/仲裁/事件）|
| [04 事件总线](./04_event_bus/README.md) | EventBus、事件 Schema、广播路由、注入队列 |
| [05 数据模型](./05_data_models/README.md) | 所有核心实体的 Schema 定义 |
| [06 存储与检索](./06_storage_and_retrieval/README.md) | 持久化策略、RAG 设计、惰性求值实现 |
| [07 初始化流程](./07_initialization_flow/README.md) | 初始化 Pipeline、创世文档 Schema、分发机制 |
| [08 错误处理](./08_error_handling/README.md) | 阻塞式重试、错误分类、日志策略 |
| [09 可扩展性](./09_extensibility/README.md) | 框架扩展点、游戏作者接口 |
