# 输入层 Pipeline

## 步骤序列

```
输入：raw PlayerInput string

Step 1: ValidationStep（代码）
  - 非空检查
  - 长度限制检查（过长截断）
  - 输出：通过的原始文本

Step 2: InputParserStep（AI 层）
  - LLM 解析玩家输入
  - 输出：ParsedIntent { intent, tone_signals, atomic_actions[], world_wishes[] }
  - tone_signals 为 0.0–1.0 的情感强度值（sarcasm, hostility, playfulness, romantic, contempt）

Step 3: WorldAssertionFilterStep（代码，可选）
  - 受 GameplayOptions.world_assertion 开关控制
  - 从 parsed_intent 中提取 world_wishes（玩家试图控制世界的断言）
  - 将 world_wishes 写入上下文供下游参考，但不作为实际行动

Step 4: ActionValidationStep（代码）
  - 确保 atomic_actions 非空
  - 按 action.order 排序
  - 验证动作结构完整性

Step 5: ToneSignalStep（代码）
  - 将 tone_signals 归一化后写入 PipelineContext
  - 供反思阶段使用

输出：通过 PipelineContext.data 传递 parsed_intent，进入反思阶段
```

---

## 与反思阶段的数据接口

```
type ParsedIntent = {
  intent: string,
  tone_signals: {
    sarcasm: number,
    hostility: number,
    playfulness: number,
    romantic: number,
    contempt: number,
  },
  atomic_actions: AtomicAction[],
  world_wishes: string[],
}
```

此对象通过 `PipelineContext.data.set('parsed_intent', ...)` 传递，后续阶段直接从 context 中读取。
