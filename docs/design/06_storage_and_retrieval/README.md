# 06 存储与检索架构

## 存储需求矩阵

| 数据 | 写入模式 | 读取模式 | 推荐存储类型 |
|------|---------|---------|------------|
| Event（Tier 1-4）| 追加写，不修改 | 按 ID 精确查询；按时间范围扫描 | 追加写日志（append-only log）|
| WorldState | 更新写 | 按 ID 查询 | KV 存储 |
| CharacterState | 更新写 | 按 NPC ID 查询 | KV 存储 |
| SubjectiveMemory（缓冲）| 追加写，定期截断 | 按 NPC ID 范围查询 | KV 存储（有序列表）|
| SubjectiveMemory（长期）| 追加写 | 按 participant_id 过滤 + 时间倒序 | KV 存储（有序列表）|
| LoreEntry | 追加写（因果链增长）| 按 subject_id 查询 | 结构化存储（KV）|
| TraitWeight | 更新写 | 按 trait_id 查询；全量读取 | KV 存储 |
| SessionStore | 一次写（创世文档）；快照追加 | 按 session_id 查询 | 文件存储或 KV |
| ConversationHistory | 追加写，定期压缩 | 按 NPC ID 范围查询 | KV 存储（有序列表）|

---

## 检索策略（首版：无向量索引）

首版不使用向量数据库和 Embedding，所有检索基于 ID 过滤 + 文本匹配：

- **NPC 长期记忆**：按 `participant_ids` 过滤（"与当前对话对象相关的事件"）+ 按 `recorded_at_turn` 时间倒序取最近 N 条
- **Lore 检索**：按 `subject_ids` 精确匹配 + `fact_type` 过滤

首版数据量（每局游戏几十到几百条记忆/Lore）下，ID 过滤足够精准。

**后续扩展**：当数据量增长到 ID 过滤不够用时，可引入 `IVectorStore` 接口和 Embedding 模型，对 `Event.summary`（Tier 2）和 `LoreEntry.content` 建立向量索引，实现语义检索。接口已预留，不影响上层代码。

---

## 存储层接口定义（Infrastructure 层）

所有存储通过接口暴露，Domain 层和 AI 层不直接依赖具体存储实现：

```typescript
interface IEventStore {
  append(event: Event): Promise<void>
  getTier1(event_id: string): Promise<EventTier1>
  getTiers(event_id: string, tiers: number[]): Promise<Partial<Event>>
  scanByTimeRange(from: GameTimestamp, to: GameTimestamp): Promise<EventTier1[]>
  scanByParticipant(npc_id: string, limit: number): Promise<EventTier1[]>
}

interface IStateStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  // key 遵循命名空间规范，如 "world:location:{id}"
}

interface ILoreStore {
  append(entry: LoreEntry): Promise<void>
  findBySubject(subject_id: string): Promise<LoreEntry[]>
  findByContentHash(hash: string): Promise<LoreEntry | null>
}

// 后续扩展：向量检索接口（首版不实现）
// interface IVectorStore {
//   upsert(namespace: string, id: string, vector: number[], metadata: object): Promise<void>
//   query(namespace: string, query_vector: number[], top_k: number): Promise<VectorMatch[]>
// }
```

---

## 详细文档

- [持久化策略](./persistence_strategy.md)
- [RAG 检索设计](./rag_design.md)
- [惰性求值实现](./lazy_evaluation_design.md)
