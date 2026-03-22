# 事件生成 Pipeline

## 步骤序列

```
输入：ArbitrationResult { action, force_flag, force_level }

Step 1: 组装事件生成上下文（ContextAssembler）
  - 参与者当前状态摘要
  - 当前地点状态
  - 近期相关事件（RAG 召回）
  - 世界状态摘要
  - force_flag 和 force_level 注入指令区

Step 2: EventGenerator LLM 调用（AI 层）
  - 生成 { title, tags, weight, summary, context, narrative_text, state_changes }
  - 忠实执行玩家行为，社交失当的行为由世界产生合理后果（NPC 愤怒、卫兵介入等）
  - force_level > 0 时，Prompt 指令区包含负面后果权重提示

Step 3: 事件 Schema 校验（ResponseParser）
  - 校验所有必填字段
  - weight 枚举校验
  - narrative_text 非空校验

Step 4: 生成事件 ID（代码）
  - 全局唯一 ID（UUID 或时间戳+序列号）

Step 5: 写入 EventStore（StateUpdate）
  - 写入 Tier 1+2（必须同步完成）
  - 写入 Tier 3+4（同步，同一事务）
  - 写入成功前不触发后续步骤

Step 6: 信号 B 标注（AI 层，条件触发）
  - 触发条件：event.tags 包含关系变化或重要选择类标签
  - SignalBTagger LLM 调用
  - 输出 choice_signals → 写入 TraitWeightQueue

Step 7: 触发 EventBus 广播（代码）
  - 发布 event.tier1 到 EventBus
  - 异步，不等待消费者完成

Step 8: 返回叙事文本
  - 将 narrative_text 放入 PipelineContext
  - 作为本次 Pipeline 的最终输出返回给 Interface 层

输出：NarrativeOutput { narrative_text, event_id }
```

---

## force_level 对生成的影响

Prompt 指令区根据 force_level 注入不同程度的提示：

```
force_level = 0: 正常生成
force_level = 1（一次坚持后）:
  "玩家在被提醒后仍然执行此行动。
   生成轻度负面后果：如 NPC 的轻微不满、机会稍纵即逝。"
force_level = 2（明确确认坚持）:
  "玩家明确无视警告强行执行此行动。
   生成显著负面后果：关系损伤、窗口关闭、世界对此有实质反应。"
```

---

## 与 Lore 固化的接口

事件写入 EventStore 后，Lore 固化模块通过 EventBus 订阅到事件，
从 Tier 4 叙事文本中提取可固化事实（异步，不在 EventPipeline 中执行）。
