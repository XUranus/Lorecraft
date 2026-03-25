#!/usr/bin/env node

import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setGlobalDispatcher, ProxyAgent } from 'undici'
import type { ILLMProvider } from './ai/runner/llm-provider.js'
import { AnthropicProvider } from './ai/runner/anthropic-provider.js'
import { GeminiProvider } from './ai/runner/gemini-provider.js'
import { OpenAIProvider } from './ai/runner/openai-provider.js'
import { loadLLMConfig, createProviderFromConfig } from './server/llm-config.js'

// ============================================================
// Config Loading: ~/.config/lorecraft/.env → project .env → env vars
// ============================================================

function loadConfig(): void {
  // Priority 1: XDG_CONFIG_HOME or ~/.config/lorecraft/.env
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const globalEnv = join(xdgConfig, 'lorecraft', '.env')

  if (existsSync(globalEnv)) {
    config({ path: globalEnv })
    return
  }

  // Priority 2: project root .env (fallback)
  config()
}

loadConfig()

// ============================================================
// Proxy Setup: make Node.js fetch respect http_proxy / https_proxy
// ============================================================

function setupProxy(): void {
  const proxyUrl =
    process.env.https_proxy ??
    process.env.HTTPS_PROXY ??
    process.env.http_proxy ??
    process.env.HTTP_PROXY ??
    process.env.ALL_PROXY

  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl))
  }
}

setupProxy()

// ============================================================
// Provider Selection
// ============================================================

function createProvider(): ILLMProvider {
  // Priority 0: Saved UI config (from settings page)
  const savedConfig = loadLLMConfig()
  if (savedConfig && savedConfig.api_key) {
    try {
      const provider = createProviderFromConfig(savedConfig)
      console.log(`[LLM] Using saved config: ${savedConfig.provider} / ${savedConfig.model || 'default'}`)
      return provider
    } catch {
      console.warn('[LLM] Saved config invalid, falling back to env vars')
    }
  }

  const providerName = process.env.LLM_PROVIDER?.toLowerCase() ?? 'auto'

  if (providerName === 'gemini' || providerName === 'google') {
    return new GeminiProvider(
      process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
      process.env.GEMINI_MODEL,
    )
  }

  if (providerName === 'anthropic' || providerName === 'claude') {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      console.error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic')
      process.exit(1)
    }
    return new AnthropicProvider({ apiKey: key, model: process.env.ANTHROPIC_MODEL })
  }

  if (providerName === 'openai' || providerName === 'openai-compatible') {
    const key = process.env.OPENAI_API_KEY
    if (!key) {
      console.error('OPENAI_API_KEY is required when LLM_PROVIDER=openai')
      process.exit(1)
    }
    return new OpenAIProvider({
      apiKey: key,
      model: process.env.OPENAI_MODEL,
      baseURL: process.env.OPENAI_BASE_URL,
    })
  }

  // Auto-detect based on available API keys
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return new GeminiProvider()
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
    })
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
      baseURL: process.env.OPENAI_BASE_URL,
    })
  }

  console.error('No API key found.')
  console.error('')
  console.error('Create config at ~/.config/lorecraft/.env :')
  console.error('')
  console.error('  mkdir -p ~/.config/lorecraft')
  console.error('  cp .env.example ~/.config/lorecraft/.env')
  console.error('  # Then edit ~/.config/lorecraft/.env and fill in your API key')
  console.error('')
  console.error('Supported keys:')
  console.error('  GEMINI_API_KEY       (Google Gemini)')
  console.error('  ANTHROPIC_API_KEY    (Anthropic Claude)')
  console.error('  OPENAI_API_KEY       (OpenAI or compatible APIs)')
  console.error('')
  console.error('For OpenAI-compatible APIs (e.g., local LLMs), set:')
  console.error('  LLM_PROVIDER=openai')
  console.error('  OPENAI_API_KEY=your-key')
  console.error('  OPENAI_BASE_URL=http://localhost:11434/v1')
  process.exit(1)
}

// ============================================================
// CLI Argument Parsing
// ============================================================

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return undefined
  const next = process.argv[idx + 1]
  return next && !next.startsWith('-') ? next : undefined
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const debug = hasFlag('--debug')
  const debugPath = debug ? (getArgValue('--debug') ?? './debug.log') : undefined

  // Database path: --db <path> or default to ~/.local/share/lorecraft/game.db
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  const dbPath = getArgValue('--db') ?? join(xdgData, 'lorecraft', 'game.db')

  console.log(`[DB] ${dbPath}`)

  // --server [port]  → start WebSocket server (+ optional web frontend)
  if (hasFlag('--server')) {
    const port = parseInt(getArgValue('--server') ?? process.env.PORT ?? '3015', 10)
    const { GameServer } = await import('./server/game-server.js')
    const provider = createProvider()
    const server = new GameServer({ port, provider, debug: debugPath, dbPath })
    await server.start()
    console.log(`Lorecraft server listening on ws://localhost:${port}`)

    // --web [port]  → also start web frontend
    if (hasFlag('--web')) {
      const webPort = parseInt(getArgValue('--web') ?? '3016', 10)
      const { WebServer } = await import('./web/web-server.js')
      const web = new WebServer({ port: webPort, wsPort: port })
      await web.start()
      console.log(`Lorecraft web UI at http://localhost:${webPort}`)
    }

    if (debug) console.log(`[DEBUG] 调试日志: ${debugPath}`)
    return
  }

  // --web [port]  → start both server and web frontend
  if (hasFlag('--web')) {
    const wsPort = parseInt(process.env.PORT ?? '3015', 10)
    const webPort = parseInt(getArgValue('--web') ?? '3016', 10)
    const { GameServer } = await import('./server/game-server.js')
    const { WebServer } = await import('./web/web-server.js')
    const provider = createProvider()
    const server = new GameServer({ port: wsPort, provider, debug: debugPath, dbPath })
    await server.start()
    const web = new WebServer({ port: webPort, wsPort: wsPort })
    await web.start()
    console.log(`Lorecraft server listening on ws://localhost:${wsPort}`)
    console.log(`Lorecraft web UI at http://localhost:${webPort}`)
    if (debug) console.log(`[DEBUG] 调试日志: ${debugPath}`)
    return
  }

  // --connect <url>  → TUI client connecting to server
  if (hasFlag('--connect')) {
    const url = getArgValue('--connect') ?? 'ws://localhost:3000'
    const { TUIClient } = await import('./interface/tui-client.js')
    const client = new TUIClient(url)
    await client.start()
    return
  }

  // Default: monolithic TUI (backward compatible)
  if (debug) {
    console.log(`[DEBUG] 调试模式已开启，日志将写入: ${debugPath}`)
  }

  const provider = createProvider()
  const { TUIApp } = await import('./interface/tui.js')
  const app = new TUIApp(provider, { debug: debugPath, dbPath })
  await app.start()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
