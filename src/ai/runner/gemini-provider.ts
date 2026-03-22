import { GoogleGenerativeAI } from '@google/generative-ai'
import type { ILLMProvider, LLMMessage, LLMResponse } from './llm-provider.js'

export class GeminiProvider implements ILLMProvider {
  private client: GoogleGenerativeAI
  private model: string

  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (!key) {
      throw new Error(
        'Gemini API key required. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable.',
      )
    }
    this.client = new GoogleGenerativeAI(key)
    this.model = model ?? 'gemini-2.5-flash'
  }

  async call(
    messages: LLMMessage[],
    options?: { temperature?: number; max_tokens?: number },
  ): Promise<LLMResponse> {
    const model = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.max_tokens ?? 4096,
      },
    })

    // Convert messages to Gemini format
    // Gemini uses system instruction separately, and alternating user/model turns
    const systemParts: string[] = []
    const history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []
    let lastUserMessage = ''

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content)
      } else if (msg.role === 'user') {
        lastUserMessage = msg.content
      } else if (msg.role === 'assistant') {
        // If there's a pending user message, add the pair
        if (lastUserMessage) {
          history.push({ role: 'user', parts: [{ text: lastUserMessage }] })
          history.push({ role: 'model', parts: [{ text: msg.content }] })
          lastUserMessage = ''
        }
      }
    }

    // Build the chat or use generateContent
    if (systemParts.length > 0 || history.length > 0) {
      const chat = this.client
        .getGenerativeModel({
          model: this.model,
          systemInstruction: systemParts.length > 0 ? systemParts.join('\n') : undefined,
          generationConfig: {
            temperature: options?.temperature ?? 0.7,
            maxOutputTokens: options?.max_tokens ?? 4096,
          },
        })
        .startChat({ history })

      const result = await chat.sendMessage(lastUserMessage || 'Continue.')
      const response = result.response
      const text = response.text()
      const usage = response.usageMetadata

      return {
        content: text,
        usage: usage
          ? {
              input_tokens: usage.promptTokenCount ?? 0,
              output_tokens: usage.candidatesTokenCount ?? 0,
            }
          : undefined,
      }
    }

    // Simple single-turn
    const result = await model.generateContent(lastUserMessage || messages[0]?.content || '')
    const response = result.response
    const text = response.text()
    const usage = response.usageMetadata

    return {
      content: text,
      usage: usage
        ? {
            input_tokens: usage.promptTokenCount ?? 0,
            output_tokens: usage.candidatesTokenCount ?? 0,
          }
        : undefined,
    }
  }
}
