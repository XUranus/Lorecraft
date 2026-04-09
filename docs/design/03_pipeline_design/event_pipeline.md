# 事件生成 Pipeline

## 步骤序列

```
输入：ArbitrationResult { action, force_flag, force_level, drift_flag }

Step 1: PacingStep（规则驱动，非 LLM）
  - 根据近期事件权重判断节奏：QUICK（快速交互）或 NARRATIVE（展开叙事）
  - 连续 3+ 高张力事件时强制使用低权重 + 喘息内容

Step 2: EventGeneratorStep（AI 层）
  - 生成 { title, tags, weight, summary, context, narrative_text, state_changes, character_observations, choices }
  - 忠实执行玩家行为，社交失当的行为由世界产生合理后果（NPC 愤怒、卫兵介入等）
  - force_level > 0 时，Prompt 指令区包含负面后果权重提示
  - 每次固定生成 2 个后续选项（含可选的属性检定信息）
  - 接收叙事阶段方向和场景节拍作为生成指导

Step 3: EventSchemaValidationStep（ResponseParser）
  - 校验所有必填字段
  - weight 枚举校验
  - narrative_text 非空校验

Step 4: EventIdStep（代码）
  - 生成全局唯一 UUID

Step 5: EventWriteStep（StateUpdate）
  - 写入 Tier 1-4 至 EventStore（同步，同一事务）
  - 写入成功前不触发后续步骤

Step 6: StateWritebackStep（代码）
  - 更新主观记忆（recent_narrative, known_facts, known_characters）
  - 更新客观世界状态摘要
  - 更新玩家对 NPC 的认知（CharacterKnowledge）
  - 处理位置变更

Step 7: QuestTrackingStep（AI 层，非关键）
  - LLM 分析当前事件是否推进、创建或完结任务线
  - 输出增量更新（delta）：新任务、新节点、新连线、完成/失败标记
  - 应用 delta 至任务图，写回 StateStore
  - 失败时静默跳过，不中断主流程

Step 8: NarrativeProgressStep（AI 层，可选）
  - 检查当前叙事阶段目标是否达成
  - 必要时推进至下一阶段并生成新的场景节拍计划
  - 受 GameplayOptions.narrative_progress 开关控制

Step 9: EventBroadcastStep（代码）
  - 将 narrative_text 和 choices 放入 PipelineContext
  - 作为本次 Pipeline 的最终输出返回给 Interface 层

输出：NarrativeOutput { narrative_text, source }
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

---

## 回合结束后的异步处理

Pipeline 主链完成后，GameLoop 依次执行：
1. **AgentScheduler.runEndOfTurn()** — NPC 意图生成、Tier 升降级、注入队列清理
2. **NarrativeRailAgent.assessDrift()** — 漂移评估与三级干预注入
