import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { AISdkProvider, type AISdkProviderType } from '../ai/runner/ai-sdk-provider.js'

// ============================================================
// LLM Config Types
// ============================================================

export type LLMProviderType = AISdkProviderType

export interface LLMConfig {
  provider: LLMProviderType
  api_key: string
  model: string
  base_url?: string        // for openai_compatible
  resource_name?: string   // for azure
  region?: string          // for bedrock
  access_key_id?: string   // for bedrock
  secret_access_key?: string // for bedrock
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

// ============================================================
// Environment Variable Detection
// ============================================================

/** Provider name → env var key(s) for API key */
const ENV_KEY_MAP: Array<{
  names: string[]            // accepted LLM_PROVIDER values
  provider: LLMProviderType
  keyEnvs: string[]          // env vars to check for API key, in priority order
  modelEnv?: string
}> = [
  { names: ['gemini', 'google'],        provider: 'gemini',     keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], modelEnv: 'GEMINI_MODEL' },
  { names: ['anthropic', 'claude'],     provider: 'anthropic',  keyEnvs: ['ANTHROPIC_API_KEY'],                modelEnv: 'ANTHROPIC_MODEL' },
  { names: ['xai', 'grok'],            provider: 'xai',        keyEnvs: ['XAI_API_KEY'],                      modelEnv: 'XAI_MODEL' },
  { names: ['openai'],                  provider: 'openai',     keyEnvs: ['OPENAI_API_KEY'],                   modelEnv: 'OPENAI_MODEL' },
  { names: ['openai_compatible', 'openai-compatible'], provider: 'openai_compatible', keyEnvs: ['OPENAI_API_KEY'], modelEnv: 'OPENAI_MODEL' },
  { names: ['mistral'],                 provider: 'mistral',    keyEnvs: ['MISTRAL_API_KEY'],                  modelEnv: 'MISTRAL_MODEL' },
  { names: ['deepseek'],                provider: 'deepseek',   keyEnvs: ['DEEPSEEK_API_KEY'],                 modelEnv: 'DEEPSEEK_MODEL' },
  { names: ['groq'],                    provider: 'groq',       keyEnvs: ['GROQ_API_KEY'],                     modelEnv: 'GROQ_MODEL' },
  { names: ['cohere'],                  provider: 'cohere',     keyEnvs: ['COHERE_API_KEY', 'CO_API_KEY'],     modelEnv: 'COHERE_MODEL' },
  { names: ['perplexity'],              provider: 'perplexity', keyEnvs: ['PERPLEXITY_API_KEY'],               modelEnv: 'PERPLEXITY_MODEL' },
  { names: ['togetherai', 'together'],  provider: 'togetherai', keyEnvs: ['TOGETHER_API_KEY'],                 modelEnv: 'TOGETHER_MODEL' },
  { names: ['azure'],                   provider: 'azure',      keyEnvs: ['AZURE_API_KEY'],                    modelEnv: 'AZURE_MODEL' },
  { names: ['bedrock'],                 provider: 'bedrock',    keyEnvs: ['AWS_ACCESS_KEY_ID'],                modelEnv: 'BEDROCK_MODEL' },
]

function findKeyFromEnv(keyEnvs: string[]): string | undefined {
  for (const env of keyEnvs) {
    if (process.env[env]) return process.env[env]
  }
  return undefined
}

/** Detect config from environment variables (fallback when no llm-config.json) */
export function detectEnvConfig(): LLMConfig | null {
  const providerName = process.env.LLM_PROVIDER?.toLowerCase()

  // Explicit provider selection
  if (providerName) {
    const entry = ENV_KEY_MAP.find(e => e.names.includes(providerName))
    if (entry) {
      const key = findKeyFromEnv(entry.keyEnvs)
      if (key) {
        const config: LLMConfig = {
          provider: entry.provider,
          api_key: key,
          model: (entry.modelEnv && process.env[entry.modelEnv]) ?? '',
        }
        if (entry.provider === 'openai_compatible') config.base_url = process.env.OPENAI_BASE_URL
        if (entry.provider === 'openai' && process.env.OPENAI_BASE_URL) {
          config.provider = 'openai_compatible'
          config.base_url = process.env.OPENAI_BASE_URL
        }
        if (entry.provider === 'azure') config.resource_name = process.env.AZURE_RESOURCE_NAME
        if (entry.provider === 'bedrock') {
          config.region = process.env.AWS_REGION ?? 'us-east-1'
          config.access_key_id = process.env.AWS_ACCESS_KEY_ID
          config.secret_access_key = process.env.AWS_SECRET_ACCESS_KEY
        }
        return config
      }
    }
  }

  // Auto-detect by available keys (first match wins)
  for (const entry of ENV_KEY_MAP) {
    // Skip openai_compatible in auto-detect (openai covers it)
    if (entry.provider === 'openai_compatible') continue
    const key = findKeyFromEnv(entry.keyEnvs)
    if (key) {
      const config: LLMConfig = {
        provider: entry.provider,
        api_key: key,
        model: (entry.modelEnv && process.env[entry.modelEnv]) ?? '',
      }
      if (entry.provider === 'openai' && process.env.OPENAI_BASE_URL) {
        config.provider = 'openai_compatible'
        config.base_url = process.env.OPENAI_BASE_URL
      }
      if (entry.provider === 'bedrock') {
        config.region = process.env.AWS_REGION ?? 'us-east-1'
        config.access_key_id = process.env.AWS_ACCESS_KEY_ID
        config.secret_access_key = process.env.AWS_SECRET_ACCESS_KEY
      }
      return config
    }
  }

  return null
}

// ============================================================
// Provider Factory
// ============================================================

export function createProviderFromConfig(config: LLMConfig): ILLMProvider {
  return new AISdkProvider({
    provider: config.provider,
    apiKey: config.api_key,
    model: config.model || '',
    baseURL: config.base_url,
    resourceName: config.resource_name,
    region: config.region,
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
  })
}

// ============================================================
// Connectivity Test & Model Listing
// ============================================================

export async function testLLMConnection(config: LLMConfig): Promise<{ success: boolean; message: string }> {
  try {
    const provider = createProviderFromConfig(config)
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

/** Known models for providers without list API */
const KNOWN_MODELS: Partial<Record<LLMProviderType, string[]>> = {
  xai: [
    'grok-4', 'grok-4-0709',
    'grok-4.20-0309-reasoning', 'grok-4-1-fast-reasoning',
    'grok-4.20-multi-agent-0309',
    'grok-4.20-0309-non-reasoning', 'grok-4-1-fast-non-reasoning',
  ],
  anthropic: [
    'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
    'claude-haiku-4-20250414',
    'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
  ],
  mistral: [
    'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest',
    'codestral-latest', 'open-mistral-nemo',
  ],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  groq: [
    'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
    'mixtral-8x7b-32768', 'gemma2-9b-it',
  ],
  cohere: ['command-r-plus', 'command-r', 'command-light'],
  perplexity: ['sonar-pro', 'sonar', 'sonar-deep-research'],
  togetherai: [
    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    'Qwen/Qwen2.5-72B-Instruct-Turbo',
    'deepseek-ai/DeepSeek-R1',
  ],
}

export async function listModels(config: Pick<LLMConfig, 'provider' | 'api_key' | 'base_url'>): Promise<string[]> {
  // Check known models first
  if (KNOWN_MODELS[config.provider]) {
    return KNOWN_MODELS[config.provider]!
  }

  if (config.provider === 'openai_compatible' || config.provider === 'openai') {
    const baseUrl = config.base_url || 'https://api.openai.com/v1'
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.api_key}` },
    })
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`)
    const data = await res.json() as { data?: Array<{ id: string }> }
    return (data.data ?? []).map(m => m.id).sort()
  }

  if (config.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.api_key}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`)
    const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> }
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .sort()
  }

  // Azure / Bedrock — model listing depends on deployment, return empty
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
