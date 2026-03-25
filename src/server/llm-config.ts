import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { OpenAIProvider } from '../ai/runner/openai-provider.js'
import { GeminiProvider } from '../ai/runner/gemini-provider.js'
import { AnthropicProvider } from '../ai/runner/anthropic-provider.js'

// ============================================================
// LLM Config Types
// ============================================================

export type LLMProviderType = 'openai_compatible' | 'gemini' | 'openai' | 'anthropic'

export interface LLMConfig {
  provider: LLMProviderType
  api_key: string
  model: string
  base_url?: string  // only for openai_compatible
}

// ============================================================
// Config File Management
// ============================================================

const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'lorecraft',
)
const CONFIG_PATH = join(CONFIG_DIR, 'llm-config.json')

export function loadLLMConfig(): LLMConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as LLMConfig
  } catch {
    return null
  }
}

export function saveLLMConfig(config: LLMConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

/** Detect config from environment variables (fallback when no llm-config.json) */
export function detectEnvConfig(): LLMConfig | null {
  const providerName = process.env.LLM_PROVIDER?.toLowerCase()

  if (providerName === 'gemini' || providerName === 'google') {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (key) return { provider: 'gemini', api_key: key, model: process.env.GEMINI_MODEL ?? '' }
  }

  if (providerName === 'anthropic' || providerName === 'claude') {
    const key = process.env.ANTHROPIC_API_KEY
    if (key) return { provider: 'anthropic', api_key: key, model: process.env.ANTHROPIC_MODEL ?? '' }
  }

  if (providerName === 'openai' || providerName === 'openai-compatible') {
    const key = process.env.OPENAI_API_KEY
    if (key) return {
      provider: process.env.OPENAI_BASE_URL ? 'openai_compatible' : 'openai',
      api_key: key,
      model: process.env.OPENAI_MODEL ?? '',
      base_url: process.env.OPENAI_BASE_URL,
    }
  }

  // Auto-detect by available keys
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return { provider: 'gemini', api_key: (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)!, model: process.env.GEMINI_MODEL ?? '' }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', api_key: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL ?? '' }
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: process.env.OPENAI_BASE_URL ? 'openai_compatible' : 'openai',
      api_key: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? '',
      base_url: process.env.OPENAI_BASE_URL,
    }
  }

  return null
}

// ============================================================
// Provider Factory
// ============================================================

export function createProviderFromConfig(config: LLMConfig): ILLMProvider {
  switch (config.provider) {
    case 'openai_compatible':
      return new OpenAIProvider({
        apiKey: config.api_key,
        model: config.model || undefined,
        baseURL: config.base_url || undefined,
      })

    case 'openai':
      return new OpenAIProvider({
        apiKey: config.api_key,
        model: config.model || undefined,
      })

    case 'gemini':
      return new GeminiProvider(config.api_key, config.model || undefined)

    case 'anthropic':
      return new AnthropicProvider({
        apiKey: config.api_key,
        model: config.model || undefined,
      })

    default:
      throw new Error(`Unknown provider type: ${config.provider}`)
  }
}

// ============================================================
// Connectivity Test & Model Listing
// ============================================================

export async function testLLMConnection(config: LLMConfig): Promise<{ success: boolean; message: string }> {
  try {
    const provider = createProviderFromConfig(config)
    // Minimal call to verify auth
    await provider.call(
      [{ role: 'user', content: 'Reply with OK' }],
      { max_tokens: 4, temperature: 0 },
    )
    return { success: true, message: '连接成功' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: msg }
  }
}

export async function listModels(config: Pick<LLMConfig, 'provider' | 'api_key' | 'base_url'>): Promise<string[]> {
  if (config.provider === 'openai_compatible' || config.provider === 'openai') {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({
      apiKey: config.api_key,
      ...(config.base_url && { baseURL: config.base_url }),
    })
    const list = await client.models.list()
    const models: string[] = []
    for await (const model of list) {
      models.push(model.id)
    }
    models.sort()
    return models
  }

  if (config.provider === 'anthropic') {
    // Anthropic has no list models API — return known models
    return [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250414',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ]
  }

  if (config.provider === 'gemini') {
    // Gemini SDK doesn't expose listModels — use REST API
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.api_key}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`)
    const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> }
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .sort()
  }

  return []
}

/** Redact API key for sending to frontend */
export function redactConfig(config: LLMConfig): LLMConfig {
  return {
    ...config,
    api_key: config.api_key
      ? config.api_key.slice(0, 4) + '****' + config.api_key.slice(-4)
      : '',
  }
}
