# 仲裁层 Pipeline

> 本文档为技术实现参考。概念设计见 [03 仲裁层](../../architecture/03_arbitration_layer/README.md)。

## 设计原则

- 五维评估（信息/物理/社会/叙事/逻辑）合并为**单次 LLM 调用**，减少延迟和 token 消耗
- 所有上下文（主观记忆、客观状态、Lore、近期事件、叙事阶段、场景节拍）在调用前并发查询
- LLM 自由判断各维度是否通过，不通过时直接生成叙事内拒绝文本
- 无硬编码枚举——动作类型、拒绝策略均由 LLM 语义判断
- **社交行为永远放行**——仲裁层只拦截物理/逻辑上不可能的行为
- 整个仲裁阶段受 `GameplayOptions.action_arbiter` 开关控制，关闭时自动通过

---

## 步骤序列

```
输入：AtomicAction（单个原子动作）+ PipelineContext

Step 1: FullContextStep（代码，并发查询）
  Promise.all([
    主观记忆（memory:subjective:{characterId}）    → 用于信息维度
    客观世界状态（world:objective:{characterId}）   → 用于物理/空间维度
    Lore 相关条目（按 action.target 查询）          → 用于逻辑一致性维度
    近期事件历史（最近 10 条 Tier1）                → 用于叙事漂移维度
    叙事阶段 + 当前节拍                             → 用于叙事方向指导
    世界基调                                        → 用于语气一致性
  ])
  注：通过 inputMapper 从 parsed_intent.atomic_actions[0] 获取输入

Step 2: ActionArbiterStep（单次 LLM 评估 + d100 检定）
  将动作 + 所有上下文传给 LLM，要求评估：
    1. 信息完整性
    2. 物理/空间可行性
    3. 社会可行性
    4. 叙事漂移（仅标记，不拒绝）
    5. 逻辑一致性

  LLM 同时判断是否需要属性检定：
    ├─ needs_check: true → 指定 attribute_id + difficulty + modifiers
    └─ needs_check: false → 跳过检定

  若 needs_check=true，代码执行 d100 属性检定：
    roll = random(1-100)
    target = difficulty_midpoint + sum(modifiers)
    total = roll + attribute_value
    passed = total >= target
    特殊规则：roll ≤ 5 为大失败，roll ≥ 95 为大成功

  可行性不通过 → 短路返回叙事拒绝文本

  若上下文有 predetermined_check（来自选项选择），跳过 LLM 判断直接执行检定

Step 3: ArbitrationResultStep（代码）
  组装 ArbitrationResult {
    action, force_flag, force_level, drift_flag,
    attribute_check（检定结果，写入 context）
  }
  传递给事件阶段

输出：ArbitrationResult
```

---

## 属性检定难度表

| 难度 | 目标值范围 | 中位数 |
|------|-----------|--------|
| TRIVIAL | 40-60 | 50 |
| ROUTINE | 70-90 | 80 |
| HARD | 100-120 | 110 |
| VERY_HARD | 130-150 | 140 |
| LEGENDARY | 160-180 | 170 |

前端选项展示时会根据玩家属性值计算通过概率：`passChance = max(0, min(100, 101 - target + attrValue))`

---

## LLM 输出

```json
{
  "passed": boolean,
  "checks": [
    { "dimension": string, "passed": boolean, "reason": string | null }
  ],
  "drift_flag": boolean,
  "rejection_narrative": string | null,
  "needs_check": boolean,
  "attribute": string | null,
  "difficulty": string | null,
  "modifiers": [{ "label": string, "value": number }] | null,
  "check_reason": string | null
}
```

- `checks` 数组包含各维度的逐项评估
- `rejection_narrative` 仅在 `passed: false` 时有值，是面向玩家的叙事文本
- `drift_flag` 独立于 passed/failed，叙事漂移维永远不阻断动作
- `needs_check` 为 true 时，代码侧执行 d100 属性检定
