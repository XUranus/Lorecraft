<p align="right"><a href="README_zh.md">中文</a> | English</p>

<h1 align="center">Lorecraft</h1>

<p align="center">
  <strong>AI-Powered Conversational CRPG Engine</strong>
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
  No scripts. No dialogue trees. Just type what you want to do — the AI builds the world around you.
</p>

<p align="center">
  <a href="https://thankod.github.io/Lorecraft/">Play Now</a>
</p>

---

## What is Lorecraft?

Lorecraft is a complete RPG engine that runs entirely in your browser. You describe your character's actions in natural language, and the AI handles everything else: feasibility checks, dice rolls, narrative generation, NPC behavior, and quest progression.

All you need is an API key from any supported LLM provider.

## Features

- **Pure Browser** — Everything runs locally via WebAssembly SQLite. No backend server needed.
- **Natural Language Input** — Type anything. The engine interprets your intent, checks feasibility, and generates consequences.
- **d100 Skill Checks** — Transparent attribute-based dice rolls with difficulty scaling and situational modifiers.
- **12 World Presets** — From noir thrillers to space operas, or create your own setting.
- **8 Attributes with Inner Voices** — Each attribute has a distinct personality that speaks up at critical moments.
- **Dynamic Quests** — Quests emerge organically from your actions, tracked automatically in a flowchart view.
- **13 LLM Providers** — Gemini, Claude, OpenAI, DeepSeek, Grok, and more via Vercel AI SDK.
- **Multi-language UI** — Chinese, English, and Japanese. The narrative language follows your UI language.
- **Save Management** — Multiple save slots, session switching, and full state persistence via IndexedDB.

## Quick Start

```bash
git clone https://github.com/thankod/Lorecraft.git
cd Lorecraft && pnpm install
cd web && pnpm install && pnpm dev
```

Open `http://localhost:5173`, configure your API key in Settings, and start playing.

## Development

```bash
# Dev server with hot reload
cd web && pnpm dev

# Run tests
pnpm test

# Production build (static output in web/dist/)
cd web && pnpm build
```

The build output is fully static and can be deployed to any HTTP server (Nginx, Caddy, Vercel, GitHub Pages, etc.).

A Node.js mode (`pnpm start`) is also available for development and debugging, using better-sqlite3 instead of the WASM version.

## License

[MIT](LICENSE)
