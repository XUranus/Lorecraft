# 仲裁层 Pipeline

> 本文档为技术实现参考。概念设计见 [03 仲裁层](../../architecture/03_arbitration_layer/README.md)。

## 设计原则

- 四维评估合并为**单次 LLM 调用**，减少延迟和 token 消耗
- 所有上下文（主观记忆、客观状态、Lore、近期事件）在调用前并发查询
- LLM 自由判断各维度是否通过，不通过时直接生成叙事内拒绝文本
- 无硬编码枚举——动作类型、拒绝策略均由 LLM 语义判断
- **社交行为永远放行**——仲裁层只拦截物理/逻辑上不可能的行为

---

## 步骤序列

```
输入：AtomicAction（单个原子动作）+ PipelineContext

// 并发查询阶段（代码）
ParallelQueryStep:
  Promise.all([
    主观记忆（memory:subjective:{characterId}）    → 用于信息维度
    客观世界状态（world:objective:{characterId}）   → 用于物理/空间维度
    Lore 相关条目（按 action.target 查询）          → 用于逻辑一致性维度
    近期事件历史（最近 10 条 Tier1 标题）            → 用于叙事漂移维度
  ])

// 单次 LLM 评估
FeasibilityCheckStep:
  将动作 + 所有上下文传给 LLM，要求评估四个维度：
    1. 信息完整性
    2. 物理/空间可行性
    3. 逻辑一致性
    4. 叙事漂移（仅标记，不拒绝）

  LLM 返回综合报告：
    ├─ passed: false → 报告中包含 rejection_narrative → 短路返回
    └─ passed: true → 继续
        drift_flag 写入 context，由异步叙事轨道 Agent 处理

// 汇总结果
ArbitrationResultStep:
  组装 ArbitrationResult { passed, action, force_flag, force_level, drift_flag }
  传递给事件 Pipeline

输出：ArbitrationResult
```

---

## LLM 输入/输出

### 输入

```json
{
  "action": { "type": "MOVE_TO", "target": "mayor_office", "method": null, "order": 0 },
  "subjective_memory": { ... },
  "objective_world_state": { ... },
  "lore_context": [ ... ],
  "recent_events": ["事件标题1", "事件标题2"]
}
```

### 输出

```json
{
  "passed": boolean,
  "checks": [
    { "dimension": string, "passed": boolean, "reason": string | null }
  ],
  "drift_flag": boolean,
  "rejection_narrative": string | null
}
```

- `checks` 数组包含四个维度的逐项评估
- `rejection_narrative` 仅在 `passed: false` 时有值，是面向玩家的叙事文本
- `drift_flag` 独立于 passed/failed，第四维永远不阻断动作
