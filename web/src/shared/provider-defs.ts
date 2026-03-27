export interface ProviderEntry {
  value: string
  label: string
  needsBaseUrl?: boolean
  baseUrlPlaceholder?: string
  baseUrlHint?: string
  keyPlaceholder?: string
  defaultModel: string
}

export interface ProviderFields {
  apiKey: string
  model: string
  baseUrl: string
}

export const emptyFields: ProviderFields = { apiKey: '', model: '', baseUrl: '' }

export const PROVIDERS: ProviderEntry[] = [
  { value: 'gemini',           label: 'Google Gemini',    keyPlaceholder: 'AIza...',    defaultModel: 'gemini-2.5-flash' },
  { value: 'anthropic',        label: 'Anthropic Claude', keyPlaceholder: 'sk-ant-...', defaultModel: 'claude-sonnet-4-20250514' },
  { value: 'openai',           label: 'OpenAI',           keyPlaceholder: 'sk-...',     defaultModel: 'gpt-4o' },
  { value: 'deepseek',         label: 'DeepSeek',         keyPlaceholder: 'sk-...',     defaultModel: 'deepseek-chat' },
  { value: 'xai',              label: 'xAI Grok',         keyPlaceholder: 'xai-...',    defaultModel: 'grok-4' },
  { value: 'groq',             label: 'Groq',             keyPlaceholder: 'gsk_...',    defaultModel: 'llama-3.3-70b-versatile' },
  { value: 'mistral',          label: 'Mistral AI',                                     defaultModel: 'mistral-large-latest' },
  { value: 'cohere',           label: 'Cohere',                                         defaultModel: 'command-r-plus' },
  { value: 'togetherai',       label: 'Together AI',                                    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { value: 'perplexity',       label: 'Perplexity',       keyPlaceholder: 'pplx-...',   defaultModel: 'sonar-pro' },
  { value: 'azure',            label: 'Azure OpenAI',                                   defaultModel: 'gpt-4o-mini' },
  { value: 'bedrock',          label: 'Amazon Bedrock',                                 defaultModel: 'anthropic.claude-sonnet-4-20250514-v1:0' },
  { value: 'openai_compatible', label: 'OpenAI Compatible', needsBaseUrl: true, baseUrlPlaceholder: 'http://localhost:11434/v1', baseUrlHint: 'OpenAI compatible endpoint', defaultModel: 'gpt-4o-mini' },
]

export function getModelPlaceholder(providerValue: string): string {
  const p = PROVIDERS.find(e => e.value === providerValue)
  return p?.defaultModel ?? 'model-name'
}
