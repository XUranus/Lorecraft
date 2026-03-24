# Lorecraft

AI 驱动的对话式 CRPG 引擎（Disco Elysium 风格）。通过自然语言与 LLM 生成的世界交互——输入你想做的事，引擎判断可行性、推进叙事、演绎 NPC 反应。

## 特性

- **完整世界生成** — 开局由 LLM 生成背景设定、NPC、地点、阵营关系、叙事结构
- **8 属性内心声音** — 力量、感知、智力、魅力、体质、敏捷、意志、幸运，各有独立人格，在行动前以内心独白形式发表看法
- **d100 属性检定** — 基础难度 + 环境/准备/状态等修正项，前端透明展示决策因子
- **叙事权威系统** — 玩家只能控制自身行为，世界断言被识别并交由引擎处理
- **坚持机制** — 内心声音警告后，玩家可选择坚持或放弃
- **SQLite 持久化** — 全量数据持久化到磁盘（FTS5 trigram 全文检索），按需加载到内存
- **叙事轨道守护** — 自动检测剧情偏移，通过内心声音或 NPC 行动温和引导
- **多 LLM 支持** — Gemini、Claude、OpenAI 及兼容 API

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置 API Key

```bash
mkdir -p ~/.config/lorecraft
cp .env.example ~/.config/lorecraft/.env
```

编辑 `~/.config/lorecraft/.env`，填入你的 API Key：

```env
# Google Gemini（推荐，免费额度充足）
GEMINI_API_KEY=your-key-here

# 或 Anthropic Claude
# ANTHROPIC_API_KEY=your-key-here
```

支持的 LLM：

| Provider | 环境变量 | 默认模型 |
|----------|---------|---------|
| Google Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI / 兼容 API | `OPENAI_API_KEY` | `gpt-4o` |

引擎会自动检测可用的 Key。如果配了多个，可通过 `LLM_PROVIDER=gemini` / `anthropic` / `openai` 指定。

OpenAI 兼容 API（如本地 LLM）额外设置：

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=http://localhost:11434/v1
```

### 3. 启动游戏

```bash
# 开发模式（推荐）— 构建前端 + 启动后端 + 热重载
./dev.sh

# 或分步启动
pnpm web           # Web 模式：WS 3015 + Web 3016
pnpm start         # TUI 单体模式
```

浏览器打开 `http://localhost:3016` 即可游玩。

## 运行模式

### Web 模式（推荐）

同时启动 WebSocket 服务器和 Web 前端：

```bash
pnpm web                          # 默认 WS 3015 + Web 3016
pnpm start -- --web 8080          # 自定义 Web 端口
pnpm start -- --server 3015 --web 3016  # 分别指定
```

### TUI 单体模式

终端 TUI 和引擎在同一进程内运行：

```bash
pnpm start
```

### 客户端-服务器模式

```bash
# 终端 1：启动服务器
pnpm server

# 终端 2：连接客户端
pnpm client
```

### 调试模式

记录每次 LLM 调用的完整 prompt/响应，Web 前端 Debug 标签页显示每步的 token 用量：

```bash
pnpm start -- --debug              # 日志写入 ./debug.log
pnpm start -- --debug /tmp/debug.log  # 自定义路径
```

### 数据库路径

默认存储在 `~/.local/share/lorecraft/game.db`，可自定义：

```bash
pnpm start -- --db ./my-game.db
```

## 代理支持

```bash
export https_proxy=http://127.0.0.1:7890
pnpm start
```

## TUI 操作

| 按键 | 功能 |
|------|------|
| `Enter` | 发送输入 |
| `Esc` / `q` | 退出 |
| `Ctrl+S` | 存档 |
| `↑` `↓` / 鼠标滚轮 | 滚动叙事面板 |

## 架构

```
src/
├── ai/              # LLM 调用层（Provider、AgentRunner、响应解析、token 追踪）
├── domain/
│   ├── models/      # 领域模型（事件、属性、知识、注入、会话）
│   └── services/    # 世界生成、事件总线、叙事轨道、NPC 调度、信号处理
├── orchestration/
│   ├── pipeline/    # 管线框架（步骤链、中间件、上下文）
│   └── steps/       # 管线步骤实现
├── infrastructure/
│   └── storage/     # SQLite 持久化（schema、FTS5、适配器）
├── server/          # WebSocket 服务器与通信协议
├── interface/       # GameLoop、TUI 前端
└── main.ts          # 入口，模式切换，CLI 参数

web/
├── src/
│   ├── tabs/        # 叙事、调试标签页
│   ├── components/  # 风格选择、角色创建等 UI 组件
│   ├── hooks/       # WebSocket 通信
│   ├── stores/      # 全局状态管理
│   └── types/       # 协议类型定义
```

## 引擎管线

每轮玩家输入经过以下处理：

1. **输入解析** — 提取意图和原子动作，识别世界断言
2. **世界断言过滤** — 分离玩家行动与世界控制尝试
3. **内心反思** — 8 属性人格声音对行动发表内心独白（选择性发言，沉默为常态）
4. **坚持判定** — WARN 姿态触发坚持/放弃选择
5. **可行性仲裁** — 五维评估（信息、物理、社会、叙事可行性 + 叙事偏移）
6. **属性检定** — d100 检定，基础目标值 + 情境修正项（NPC 态度、环境、准备等）
7. **节奏判断** — 决定快速交互还是展开叙事
8. **事件生成** — 生成叙事文本（分段、对话「」、音效『』）、状态变更、世界反应
9. **状态回写** — 更新记忆和世界状态，持久化到 SQLite

## 存储架构

- **SQLite + WAL** — 全量数据持久化，支持并发读
- **FTS5 trigram** — 中文全文检索（事件、记忆、对话、知识库），短查询自动回退 LIKE
- **适配器模式** — `SQLiteStore` 通过 `asEventStore()`、`asStateStore()` 等方法提供类型安全的接口适配
- **5 个存储接口** — EventStore（事件日志）、StateStore（KV 状态）、LoreStore（知识库）、LongTermMemoryStore（NPC 记忆）、SessionStore（存档）

## 开发

```bash
./dev.sh           # 开发模式（构建前端 + 热重载后端）
pnpm test          # 运行测试
pnpm test:watch    # 监听模式
pnpm build         # 构建
```

## License

MIT
