# 03 Pipeline 设计

## 主链定义

主链（MainPipeline）是处理玩家输入的阻塞式同步调用链：
- 一次玩家输入触发一条 Pipeline 执行
- Pipeline 完成前不接受下一条输入
- 任意步骤失败 → 整链停止，等待重试

---

## Pipeline 接口设计

```
interface IPipelineStep<TInput, TOutput> {
  execute(input: TInput, context: PipelineContext) → StepResult<TOutput>
}

type StepResult<T> =
  | { status: "continue", data: T }
  | { status: "short_circuit", output: NarrativeOutput }  // 提前结束，有输出给玩家
  | { status: "error", error: PipelineError }             // 失败，向上冒泡

type PipelineContext = {
  session_id: string,
  player_character_id: string,
  turn_number: number,
  ...accumulated_data  // 各步骤可向 context 追加数据供后续步骤使用
}
```

短路（`short_circuit`）的典型场景：
- 反思系统拦截意图并等待玩家确认 → 返回内心声音文本
- 仲裁层不通过 → 返回叙事拒绝文本
- 两种情况都有输出给玩家，但不触发事件生成

---

## 主链步骤序列

```
PlayerInput
    ↓
Step 1: InputPipeline
  解析意图 → 生成原子动作序列
    ↓
Step 2: ReflectionPipeline
  评估意图 → 可选：内心声音输出
  [短路条件] 拦截时 → 返回声音文本，等待玩家确认
    ↓
Step 3: ArbitrationPipeline
  四维可行性检查（信息/物理/逻辑/漂移）
  [短路条件] 不通过 → 返回叙事拒绝文本
    ↓
Step 4: EventPipeline
  生成事件 → 写入存储 → 广播
  返回 Tier 4 叙事文本
    ↓
NarrativeOutput → Interface Layer
```

---

## 与 EventBus 的边界

Pipeline 主链是同步的，EventBus 是异步的，两者在 Step 4 末尾交接：

```
Step 4 完成：
  ├─ 同步返回：Tier 4 叙事文本（给玩家看）
  └─ 异步触发：EventBus 广播 Tier 1
               ↓
               世界 Agent 更新（异步）
               相关 NPC Agent 更新（异步）
               叙事轨道 Agent 消费（异步）
               Lore 固化（异步）
```

玩家看到叙事文本时，异步处理可能尚未完成。
但下一条玩家输入到来时，前一轮的异步处理应已完成（正常情况下）。
若未完成，Pipeline 在 Step 1 前检查异步任务状态，必要时等待。

---

## NPC 自主行动的 Pipeline

NPC 自主行动复用**相同的 Step 3 + Step 4**（仲裁 + 事件），输入来源不同：

```
AgentScheduler 触发 NPC 意图生成（NPCIntentGenerator LLM 调用）
    ↓
直接进入 ArbitrationPipeline（跳过输入层和反思系统）
    ↓
EventPipeline（生成 NPC 行动事件）
    ↓
广播（与玩家行动事件相同的流程）
```

NPC 行动产生的叙事文本如何呈现给玩家，由 Interface 层决定（框架不规定）。

---

## 子 Pipeline 文档

- [输入层 Pipeline](./input_pipeline.md)
- [反思系统 Pipeline](./reflection_pipeline.md)
- [仲裁层 Pipeline](./arbitration_pipeline.md)
- [事件生成 Pipeline](./event_pipeline.md)
