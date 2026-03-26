import { generateText, type LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createXai } from '@ai-sdk/xai'
import { createMistral } from '@ai-sdk/mistral'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGroq } from '@ai-sdk/groq'
import { createCohere } from '@ai-sdk/cohere'
import { createPerplexity } from '@ai-sdk/perplexity'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createAzure } from '@ai-sdk/azure'
import type { ILLMProvider, LLMMessage, LLMResponse } from './llm-provider.js'

export type AISdkProviderType =
  | 'openai'
  | 'openai_compatible'
  | 'anthropic'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'deepseek'
  | 'groq'
  | 'cohere'
  | 'perplexity'
  | 'togetherai'
  | 'bedrock'
  | 'azure'

export interface AISdkProviderOptions {
  provider: AISdkProviderType
  apiKey: string
  model: string
  baseURL?: string         // for openai_compatible
  // Azure-specific
  resourceName?: string    // Azure resource name
  // Bedrock-specific
  region?: string          // AWS region
  accessKeyId?: string
  secretAccessKey?: string
}

const DEFAULT_MODELS: Record<AISdkProviderType, string> = {
  openai: 'gpt-4o-mini',
  openai_compatible: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.5-flash',
  xai: 'grok-4',
  mistral: 'mistral-large-latest',
  deepseek: 'deepseek-chat',
  groq: 'llama-3.3-70b-versatile',
  cohere: 'command-r-plus',
  perplexity: 'sonar-pro',
  togetherai: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  bedrock: 'anthropic.claude-sonnet-4-20250514-v1:0',
  azure: 'gpt-4o-mini',
}

function createModel(options: AISdkProviderOptions): LanguageModel {
  const modelId = options.model || DEFAULT_MODELS[options.provider]

  switch (options.provider) {
    case 'anthropic': {
      const provider = createAnthropic({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'openai': {
      const provider = createOpenAI({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'openai_compatible': {
      const provider = createOpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      })
      return provider(modelId)
    }
    case 'gemini': {
      const provider = createGoogleGenerativeAI({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'xai': {
      const provider = createXai({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'mistral': {
      const provider = createMistral({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'deepseek': {
      const provider = createDeepSeek({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'groq': {
      const provider = createGroq({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'cohere': {
      const provider = createCohere({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'perplexity': {
      const provider = createPerplexity({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'togetherai': {
      const provider = createTogetherAI({ apiKey: options.apiKey })
      return provider(modelId)
    }
    case 'bedrock': {
      const provider = createAmazonBedrock({
        region: options.region ?? 'us-east-1',
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      })
      return provider(modelId)
    }
    case 'azure': {
      const provider = createAzure({
        apiKey: options.apiKey,
        resourceName: options.resourceName,
      })
      return provider(modelId)
    }
    default:
      throw new Error(`Unknown provider: ${options.provider}`)
  }
}

export class AISdkProvider implements ILLMProvider {
  private model: LanguageModel

  constructor(options: AISdkProviderOptions) {
    this.model = createModel(options)
  }

  async call(
    messages: LLMMessage[],
    options?: { temperature?: number; max_tokens?: number },
  ): Promise<LLMResponse> {
    const systemMessage = messages.find((m) => m.role === 'system')
    const nonSystemMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const result = await generateText({
      model: this.model,
      ...(systemMessage && { system: systemMessage.content }),
      messages: nonSystemMessages,
      maxOutputTokens: options?.max_tokens ?? 4096,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    })

    return {
      content: result.text,
      usage: result.usage
        ? {
            input_tokens: result.usage.inputTokens ?? 0,
            output_tokens: result.usage.outputTokens ?? 0,
          }
        : undefined,
    }
  }
}
