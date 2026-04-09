# 反思系统 Pipeline

## 步骤序列

```
输入：ParsedIntent（来自输入阶段）

Step 1: ActiveTraitStep（代码）
  → 读取 player:traits:{trait_id} 状态
  → 返回权重超过 threshold_active 的特质列表
  → 同时读取玩家属性，属性值 > 10 的视为活跃声音

Step 2: InjectionReadStep（代码）
  → InjectionQueueManager.dequeueReflection()
  → 返回叙事轨道注入的内心声音提示（如有）

Step 3: ShouldSpeakStep（代码）
  → 跳过条件：无活跃声音 AND 无歧义标记 AND 无注入内容
  → 满足跳过条件时短路，直接通过反思阶段

Step 4: VoiceDebateStep（单次 LLM 调用）
  → 合并了原先的声音生成与辩论生成为单次调用
  → 输出：voices[] + debate_lines[]
  → 使用 voice_debate prompt 模板

Step 5: InsistenceStep（代码，状态机）
  → 读取 context.data 中的 insistence_state
  → NORMAL + 声音警告 → 设为 WARNED，短路返回声音文本
  → WARNED + 玩家坚持 → 设为 INSISTING，携带 force_flag 继续
  → INSISTING → 完成后回归 NORMAL

Step 6: VoiceWriteStep（代码）
  → 将声音台词写入 context.data('voice_lines')
  → 供下游步骤和 Interface 层使用
```

---

## 坚持状态机

当声音拦截后，玩家可以坚持原意图或放弃。状态机由 `InsistenceStateMachine` + GameLoop 管理：

```
状态：NORMAL → WARNED → INSISTING

NORMAL:
  声音拦截后 → 进入 WARNED 状态（本轮短路，返回声音文本）
  → GameLoop 设置 pendingInsistInput，通知前端显示坚持/放弃按钮

WARNED（等待玩家操作）:
  玩家点击"坚持" → insist() → 重新执行 processInput，force_flag=true
  玩家点击"放弃" → abandon() → 返回 NORMAL，丢弃待定输入

INSISTING:
  继续进入仲裁层，force_flag=true，force_level 传入事件生成
  本轮完成后 → 返回 NORMAL
```

受 `GameplayOptions.insistence` 开关控制。关闭时跳过坚持判定，声音仅作提醒。

---

## 特质权重更新时机

信号 A（语气信号）：在输入阶段的 ToneSignalStep 中写入上下文，由 SignalProcessor 在回合内处理。
信号 B（选择信号）：在事件生成后由 EventGenerator 输出的 choice_signals 触发更新。

两种信号的更新时机不同，确保：
- 信号 A 反映玩家的输入风格（不依赖仲裁结果）
- 信号 B 反映玩家的实际选择（依赖事件确实发生）
