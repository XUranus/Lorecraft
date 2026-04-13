<p align="right">中文 | <a href="README.md">English</a></p>

<h1 align="center">Lorecraft</h1>

<p align="center">
  <strong>AI 驱动的对话式 CRPG 引擎</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/thankod/Lorecraft?style=flat-square" alt="License"></a>
  <a href="https://github.com/thankod/Lorecraft/actions/workflows/deploy-pages.yml"><img src="https://img.shields.io/github/actions/workflow/status/thankod/Lorecraft/deploy-pages.yml?style=flat-square&label=deploy" alt="Deploy"></a>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/SQLite_(WASM)-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
</p>

<p align="center">
  没有固定剧本，没有选项菜单——用自然语言描述你想做的事，AI 会围绕你构建整个世界。
</p>

<p align="center">
  <a href="https://thankod.github.io/Lorecraft/">立即体验</a>
</p>

---

## Lorecraft 是什么？

Lorecraft 是一个完整的 RPG 引擎，完全在浏览器中运行。你用自然语言描述角色的行动，引擎负责其余一切：可行性判定、骰子检定、叙事生成、NPC 行为推演和任务追踪。

你只需要一个支持的 LLM 服务商的 API Key。

## 特性

- **纯浏览器运行** — 通过 WebAssembly SQLite 在本地运行，无需后端服务。
- **自然语言输入** — 随意输入。引擎解析你的意图，判定可行性，生成后果。
- **d100 属性检定** — 透明的属性骰子检定，含难度分级和情境修正。
- **12 种世界预设** — 从黑色惊悚到太空歌剧，也可自定义设定。
- **8 项属性 + 内心声音** — 每项属性拥有独立人格，在关键时刻以内心独白形式发言。
- **动态任务系统** — 任务从你的行动中自然涌现，以流程图形式自动追踪。
- **13 家 LLM 服务商** — Gemini、Claude、OpenAI、DeepSeek、Grok 等，通过 Vercel AI SDK 统一接入。
- **多语言界面** — 中文、英文、日文。叙事语言跟随界面语言。
- **存档管理** — 多存档位、会话切换，通过 IndexedDB 完整持久化。

## 快速开始

```bash
git clone https://github.com/thankod/Lorecraft.git
cd Lorecraft && pnpm install
cd web && pnpm install && pnpm dev
```

打开 `http://localhost:5173`，在设置中配置 API Key，即可开始游戏。

## 开发

```bash
# 开发服务器（热重载）
cd web && pnpm dev

# 运行测试
pnpm test

# 生产构建（静态产物输出至 web/dist/）
cd web && pnpm build
```

构建产物为纯静态文件，可部署至任意 HTTP 服务器（Nginx、Caddy、Vercel、GitHub Pages 等）。

另有 Node.js 模式（`pnpm start`）可用于开发调试，使用 better-sqlite3 替代 WASM 版本。

## 许可证

[MIT](LICENSE)
