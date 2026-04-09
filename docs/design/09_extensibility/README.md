# 09 框架可扩展性与游戏作者接口

## 框架使用者（游戏作者）的角色

框架提供引擎，游戏作者提供世界的"基调"。
作者不需要写代码，只需要通过配置和 Prompt 覆盖来定制游戏体验。

---

## 扩展点清单

### 1. 初始化 Agent System Prompt（主要定制点）

```
文件：prompts/initialization/world_generator_v1.prompt
可覆盖区域：[IDENTITY] 中的风格配置段

覆盖方式：在 style_config 中传入，注入到 Prompt 的指定位置
默认值：通用黑色政治惊悚风格，中等复杂度
```

可配置参数：
- `tone`：叙事基调（"黑色电影"、"历史战争"、"赛博朋克"……）
- `complexity`：世界复杂度（势力数量、秘密层数、NPC 数量范围）
- `narrative_style`：叙事风格（"极乐迪斯科式"、"古典侦探式"……）
- `player_archetype`：玩家角色的初始定位（"失忆的警探"、"落魄的贵族"……）

### 2. Tier C NPC 人格模板库

```
文件：config/npc_templates.json
格式：TierCTemplate[]（见 character_state_schema.md）

作者可以：添加新的模板类型（如"神父"、"黑市商人"）
框架提供：默认模板库（"路人"、"小贩"、"守卫"等）
```

### 3. 第一层认知声音配置

```
文件：config/cognitive_voices.json
格式：{ voice_id: string, display_name: string, description: string }[]

作者可以：覆盖声音的描述（影响 Prompt 注入的人格描述）
作者可以：禁用某些声音（如想要一个纯直觉驱动的角色）
框架提供：默认声音列表（反思、规划、探究、直觉、记忆）
```

### 4. 第二层浮现特质扩展

```
文件：config/trait_configs.json
格式：TraitConfig[]（见 trait_weight_schema.md）

作者可以：添加新的特质类型
作者可以：调整现有特质的衰减速度和阈值
框架提供：默认特质列表（戏谑、无情、冲动、共情等）
```

### 5. 叙事文本风格注入

```
注入位置：所有叙事生成 Agent 的 [WORLD_CONTEXT] 尾部
配置方式：style_config.narrative_style 字符串
影响范围：EventGeneratorStep、ActionArbiterStep 拒绝叙事、NPC 响应的输出风格
```

### 6. AUTHOR_PRESET Lore 写入接口

```typescript
// 游戏作者在游戏发布前预置不可覆盖的世界事实
interface IAuthorTooling {
  presetLore(entries: AuthorLoreInput[]): Promise<void>
  listCanonicalizedLore(genesis_id: string): Promise<LoreEntry[]>  // 查看 AI 已固化的事实
}

type AuthorLoreInput = {
  content: string
  fact_type: LoreFactType
  subject_ids: string[]
}
```

---

## 框架核心不可覆盖的部分

以下是引擎的不变量，覆盖它们会破坏系统一致性：

| 不可变项 | 原因 |
|---------|------|
| 四阶段管线结构（输入→反思→仲裁→事件）| 结构决定信息隔离正确性 |
| 事件不可变原则 | 世界历史的一致性依赖于此 |
| 阻塞式错误处理 | 防止部分失败状态累积 |
| 主客观记忆命名空间隔离 | 信息不对称是设计意图，污染会破坏 NPC 行为逻辑 |
| Agent 之间不直接互调 | 高内聚低耦合的架构基础 |
| LLM 不直接写状态 | 写入一致性的关键保证 |

---

## 版本兼容性约定

- 扩展点的配置格式变更时，提供迁移工具
- Prompt 模板版本在文件名中显式标注（`_v{n}`）
- 创世文档 Schema 变更时，旧存档不自动升级（需显式迁移）
