# 记忆与 Lore 检索设计

## 首版策略：ID 过滤 + 文本检索

首版不使用向量数据库和 Embedding 模型，所有检索基于结构化字段过滤。

---

## NPC 长期记忆检索

当 NPC Agent 的 ContextAssembler 需要注入长期记忆时：

```
1. 确定检索条件
   - 当前对话对象的 ID（participant_id）
   - 当前行动涉及的地点 ID（location_id）

2. 结构化查询
   从长期记忆存储中按以下条件过滤：
   - participant_ids 包含当前对话对象
   - OR location_id 匹配当前地点
   按 recorded_at_turn 时间倒序排列
   取 top_k 条（默认 5）

3. 按需加载全文
   对检索结果中最近的 1-2 条，按需拉取 Tier 3+4
   其余条目只使用 Tier 2 摘要

4. 注入 ContextAssembler
   将结果按时间倒序注入 [RUNTIME_CONTEXT] 区的长期记忆部分
```

---

## 索引写入时机

当 `MemoryBuffer` 条目移出缓冲区时（Tier A NPC 专属）：

```
MemoryBuffer.evict(entry)
  → 写入长期记忆存储（KV 存储）
  → key: "memory:long_term:{npc_id}:{event_id}"
  → value: { event_id, subjective_summary, participant_ids, location_id, recorded_at_turn, distortion_type }
  → 同时维护按 participant_id 和 location_id 的倒排索引
```

---

## 主观记忆隔离

每个 NPC 的长期记忆按 `npc_id` 隔离存储：
- key 前缀 `memory:long_term:{npc_id}:` 确保命名空间隔离
- 同一事件，不同 NPC 存储各自的主观摘要
- 两个 NPC 的记忆检索结果天然不同

---

## Lore 检索

Lore 检索用于仲裁层 Layer 4（叙事可行性检查）和 NPC 对话上下文：

```
查询：涉及的实体 ID（NPC/地点/势力）
→ LoreStore.findBySubject(subject_id)
→ 按 authority_level 排序（AUTHOR_PRESET 优先）
→ 同级别按 created_at_turn 倒序
→ 取 top_k 条（默认 3）
→ 返回 LoreEntry（含因果链）
→ 注入 ContextAssembler
```

---

## Token 预算控制

检索结果注入 Context 时受 Token 预算约束（见 context_assembler.md）：

- 优先保留时间最近的记忆条目
- 超出预算时只保留 Tier 2 摘要，丢弃 Tier 3+4
- 最多注入 5 条长期记忆 + 3 条 Lore 条目

---

## 后续扩展：向量语义检索

当数据量增长到 ID 过滤不够精准时，可引入向量检索层：

- 添加 `IVectorStore` 接口实现
- 集成 Embedding 模型（云端 API 或本地轻量模型）
- 为 NPC 主观记忆和 Lore 建立向量索引
- ContextAssembler 的检索调用从 ID 过滤切换为向量 top-k

接口已在存储架构中预留，切换时不影响上层 Agent 代码。
