import initSqlJs from 'sql.js'
import { PromptRegistry } from '@engine/ai/prompt/prompt-registry'
import { initPrompts } from '@engine/ai/prompt/prompts'
import { SqlJsStore } from '@engine/infrastructure/storage/sqljs-store'
import { GameLoop } from '@engine/engine/game-loop'
import type { ILLMProvider } from '@engine/ai/runner/llm-provider'
import { loadLLMConfig, createProviderFromConfig } from '@engine/server/llm-config-browser'
import { NullDebugLogger } from '@engine/ai/runner/debug-logger'

// Bundle prompts via Vite's import.meta.glob
const promptModules = import.meta.glob('../../../prompts/*.prompt', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

let _engine: GameLoop | null = null
let _store: SqlJsStore | null = null
let _llmConfigured = false

export async function createEngine(): Promise<GameLoop> {
  // 1. Init prompts from bundled files
  initPrompts(PromptRegistry.fromRecord(promptModules))

  // 2. Init sql.js + load persisted DB from IndexedDB
  _store = await SqlJsStore.create(async () => {
    const SQL = await initSqlJs({
      locateFile: (file: string) => `${import.meta.env.BASE_URL}${file}`,
    })
    return SQL
  })

  // 3. Load LLM config from localStorage
  const config = loadLLMConfig()
  let provider: ILLMProvider | null = null
  if (config && config.api_key) {
    try {
      provider = createProviderFromConfig(config)
      _llmConfigured = true
    } catch {
      // Will be set later via settings UI
    }
  }

  // Create a stub provider if none configured — the user will configure via settings
  if (!provider) {
    provider = {
      async call() {
        throw new Error('请先在设置中配置大模型 API')
      },
    }
  }

  // 4. Create GameLoop
  _engine = new GameLoop(_store, provider, { debugLogger: new NullDebugLogger() })
  return _engine
}

export function getEngine(): GameLoop | null {
  return _engine
}

export function getStore(): SqlJsStore | null {
  return _store
}

export function isLLMConfigured(): boolean {
  return _llmConfigured
}

export function setLLMConfigured(v: boolean): void {
  _llmConfigured = v
}
