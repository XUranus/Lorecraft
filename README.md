# Lorecraft

AI 驱动的对话式 CRPG 引擎。无固定剧本，无选项菜单——通过自然语言与 LLM 实时生成的世界交互。

## 概述

Lorecraft 是一套完整的 AI 叙事 RPG 引擎框架。玩家以自然语言描述角色行动，引擎调用大语言模型完成可行性仲裁、属性检定（d100）、叙事生成与 NPC 行为推演。所有游戏状态持久化至 SQLite，支持存档管理与会话恢复。

引擎完整运行在浏览器内（sql.js WASM），无需后端服务，仅需一个 LLM API Key 即可开始游戏。

## 快速开始

### 安装

```bash
git clone https://github.com/thankod/Lorecraft.git
cd Lorecraft
pnpm install
cd web && pnpm install
```

### 本地开发

```bash
cd web && pnpm dev
```

浏览器访问 `http://localhost:5173`，在设置页配置 API Key 后即可开始游戏。

### 生产部署

```bash
cd web && pnpm build
```

`web/dist/` 为纯静态产物，可部署至任意 HTTP 服务器（Nginx、Caddy、Vercel、GitHub Pages 等）。

### LLM 配置

在浏览器设置页面直接配置 Provider、API Key 及模型，支持连接测试。通过 Vercel AI SDK 统一接入 13 家 Provider（Gemini、Claude、OpenAI、DeepSeek、Grok 等），亦可通过 OpenAI 兼容 API 接入本地模型。

## 游戏机制

### 世界生成

新游戏时选择预设风格或自定义设定，LLM 将生成完整世界：背景、地点、NPC 群像、阵营关系与隐藏叙事线。

**12 种预设风格**：黑色政治惊悚 · 哥特恐怖 · 西部荒野 · 奇幻史诗 · 江湖武侠 · 末日废土 · 太空歌剧 · 都市悬疑 · 校园青春 · 乡村志怪 · 职场风云 · 民国谍影

### 角色创建

400 点分配至 8 项属性（每项 0–100）：

**力量 · 体质 · 敏捷 · 智力 · 感知 · 意志 · 魅力 · 幸运**

每项属性对应一个「内心声音」人格，在关键时刻以内心独白形式提供判断与警示。

### 回合处理管线

玩家输入经过 9 阶段处理：

1. **输入解析** — 提取意图与原子动作，识别世界断言
2. **世界断言过滤** — 分离玩家行动与世界控制尝试（叙事权威系统）
3. **内心声音反思** — 属性人格选择性发言，沉默为常态
4. **坚持判定** — 内心声音发出警告时，触发坚持/放弃抉择
5. **可行性仲裁** — 信息 · 物理 · 社会 · 叙事可行性 + 叙事偏移五维评估
6. **属性检定** — d100 掷骰，基础目标值 + 情境修正项（NPC 态度、环境、准备状态等）
7. **节奏判断** — 决定快速交互或展开叙事
8. **事件生成** — 叙事文本、NPC 反应、状态变更、世界演进
9. **状态回写** — 持久化至 SQLite

### 存档系统

浏览器端数据存储于 IndexedDB（通过 sql.js 序列化），支持多存档管理、会话切换与删除。

## Node 服务器模式

引擎同时支持 Node.js 独立运行，适用于开发调试或自动化场景：

```bash
# 配置
mkdir -p ~/.config/lorecraft
cp .env.example ~/.config/lorecraft/.env

# 启动
pnpm start                            # 默认端口 3016
pnpm start -- --port 3015             # 自定义端口
pnpm start -- --debug                 # 记录完整 LLM 调用日志
pnpm start -- --db ./my-game.db       # 自定义数据库路径
```

Node 模式使用 better-sqlite3（WAL 模式）+ FTS5 trigram 中文全文检索，默认数据路径 `~/.local/share/lorecraft/game.db`。

### 代理支持

```bash
export https_proxy=http://127.0.0.1:7890
```

## 开发

```bash
cd web && pnpm dev      # 前端热重载
pnpm test               # 运行测试（189 cases）
pnpm test:watch         # 监听模式
```

## 架构

```
src/
├── ai/                # LLM 调用层（13 Provider、AgentRunner、响应解析、Prompt 注册）
├── domain/
│   ├── models/        # 领域模型（事件四层分级、属性、知识图谱、注入队列）
│   └── services/      # 世界代理、叙事轨道守护、NPC 调度、信号处理
├── orchestration/     # 管线框架（步骤链、中间件、上下文组装）
├── engine/            # GameLoop 核心（依赖注入 IStoreFactory + ILLMProvider）
├── infrastructure/    # 存储层（IStoreFactory 接口、SQLiteStore、SqlJsStore）
└── server/            # Node 服务端入口

web/
├── engine/            # 浏览器引擎引导（sql.js 初始化、Prompt 加载、Provider 创建）
├── components/        # 风格选择、角色创建、会话管理
├── tabs/              # 叙事、角色、调试、设置
├── stores/            # Zustand 状态管理
└── hooks/             # useEngine — GameLoop 与 React 的桥接层
```

## 技术特性

- **纯浏览器架构** — 引擎通过 sql.js（WASM SQLite）+ IndexedDB 在浏览器内完整运行，零服务端依赖
- **13 家 LLM Provider 统一接入** — Vercel AI SDK 适配，设置页面实时切换，支持连接测试与模型列表拉取
- **构造器依赖注入** — GameLoop 通过 IStoreFactory + ILLMProvider 接口解耦，同一套引擎代码运行在浏览器与 Node 双平台
- **d100 属性检定** — 前端透明展示难度等级、基础目标值、情境修正因子与掷骰结果
- **内心声音系统** — 8 属性各有独立人格，通过阈值门控选择性发言，避免信息过载
- **叙事轨道守护** — 自动检测剧情偏移度，通过内心声音或 NPC 行动温和引导回归主线
- **叙事权威边界** — 玩家仅控制自身行为，世界断言由引擎仲裁处理
- **19 个专用 Prompt 模板** — 世界生成、输入解析、可行性仲裁、属性检定、事件生成等环节各自独立
- **双平台存储** — 浏览器端 sql.js + IndexedDB 持久化（防抖写入 + beforeunload 兜底），Node 端 better-sqlite3 + WAL + FTS5 trigram 全文检索

## License

MIT
