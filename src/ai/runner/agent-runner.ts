import type { IDebugLogger } from './debug-logger.js'
import type { ILLMProvider, LLMMessage, LLMResponse } from './llm-provider.js'

export interface LLMCallLog {
  call_id: string
  agent_type: string
  input_hash: string
  output_hash: string
  duration_ms: number
  status: 'success' | 'error'
  error?: string
  timestamp: number
}

export interface AgentRunnerOptions {
  timeout_ms?: number
  max_retries?: number
  base_delay_ms?: number
  language?: string
  debugLogger?: IDebugLogger
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

let callCounter = 0

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

export interface LLMCallDetail {
  agent_type: string
  messages: LLMMessage[]
  response: string
  duration_ms: number
  usage?: TokenUsage
}

export class AgentRunner {
  private provider: ILLMProvider
  private logs: LLMCallLog[] = []
  private timeout: number
  private maxRetries: number
  private baseDelay: number
  private language: string | undefined
  private logger: IDebugLogger | null
  private turnCounter = 0
  private _pendingUsage: TokenUsage[] = []
  private _pendingCalls: LLMCallDetail[] = []

  setProvider(provider: ILLMProvider): void {
    this.provider = provider
  }

  setLanguage(lang: string): void {
    this.language = lang
  }

  constructor(provider: ILLMProvider, options?: AgentRunnerOptions) {
    this.provider = provider
    this.timeout = options?.timeout_ms ?? 30_000
    this.maxRetries = options?.max_retries ?? 3
    this.baseDelay = options?.base_delay_ms ?? 1_000
    this.language = options?.language
    this.logger = options?.debugLogger ?? null
  }

  /** Call this at the start of each player turn to mark turn boundaries in the log. */
  markTurn(turnNumber: number, playerInput?: string): void {
    this.turnCounter = turnNumber
    if (this.logger) {
      const sep = '═'.repeat(80)
      this.logger.append(`\n${sep}\n  TURN ${turnNumber}${playerInput ? `  |  Player input: ${playerInput}` : ''}\n${sep}\n\n`)
    }
  }

  async run(
    messages: LLMMessage[],
    options?: { temperature?: number; max_tokens?: number; agent_type?: string },
  ): Promise<LLMResponse> {
    const callId = `call_${Date.now()}_${++callCounter}`
    const agentType = options?.agent_type ?? 'unknown'
    const inputHash = simpleHash(JSON.stringify(messages))
    const start = Date.now()

    // Inject language instruction into the first system message
    if (this.language) {
      const langInstruction = `IMPORTANT: All text content in your response (narrative, dialogue, descriptions, voice lines, etc.) MUST be written in ${this.language}. JSON field names remain in English, but all string values that represent in-game content must be in ${this.language}.`
      const sysIdx = messages.findIndex((m) => m.role === 'system')
      if (sysIdx >= 0) {
        messages = messages.map((m, i) =>
          i === sysIdx ? { ...m, content: m.content + '\n\n' + langInstruction } : m,
        )
      } else {
        messages = [{ role: 'system', content: langInstruction }, ...messages]
      }
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.callWithTimeout(messages, options)
        const duration = Date.now() - start

        this.logs.push({
          call_id: callId,
          agent_type: agentType,
          input_hash: inputHash,
          output_hash: simpleHash(response.content),
          duration_ms: duration,
          status: 'success',
          timestamp: Date.now(),
        })

        if (response.usage) {
          this._pendingUsage.push(response.usage)
        }

        this._pendingCalls.push({
          agent_type: agentType,
          messages: messages,
          response: response.content,
          duration_ms: duration,
          usage: response.usage,
        })

        this.writeDebug(callId, agentType, messages, duration, response.content)

        return response
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))

        if (attempt < this.maxRetries - 1) {
          const delay = this.baseDelay * Math.pow(2, attempt)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    const duration = Date.now() - start
    this.logs.push({
      call_id: callId,
      agent_type: agentType,
      input_hash: inputHash,
      output_hash: '',
      duration_ms: duration,
      status: 'error',
      error: lastError?.message,
      timestamp: Date.now(),
    })

    this.writeDebug(callId, agentType, messages, duration, null, lastError?.message)

    throw lastError
  }

  /** Drain all token usage accumulated since last drain. Used by debug middleware. */
  drainUsage(): TokenUsage[] {
    const usage = this._pendingUsage
    this._pendingUsage = []
    return usage
  }

  /** Drain all LLM call details accumulated since last drain. Used by debug middleware. */
  drainCalls(): LLMCallDetail[] {
    const calls = this._pendingCalls
    this._pendingCalls = []
    return calls
  }

  getLogs(): readonly LLMCallLog[] {
    return this.logs
  }

  private writeDebug(
    callId: string,
    agentType: string,
    messages: LLMMessage[],
    durationMs: number,
    responseContent: string | null,
    error?: string,
  ): void {
    if (!this.logger) return

    const lines: string[] = []
    const sep = '─'.repeat(60)

    lines.push(`${sep}`)
    lines.push(`[${agentType}]  ${callId}  (${durationMs}ms)  turn=${this.turnCounter}`)
    lines.push(`${sep}`)

    for (const msg of messages) {
      lines.push(`\n◆ ${msg.role.toUpperCase()}:`)
      lines.push(msg.content)
    }

    if (error) {
      lines.push(`\n✖ ERROR: ${error}`)
    } else if (responseContent) {
      lines.push(`\n◆ RESPONSE:`)
      // Pretty-print JSON if possible
      try {
        const parsed = JSON.parse(responseContent)
        lines.push(JSON.stringify(parsed, null, 2))
      } catch {
        lines.push(responseContent)
      }
    }

    lines.push('\n')
    this.logger.append(lines.join('\n'))
  }

  private callWithTimeout(
    messages: LLMMessage[],
    options?: { temperature?: number; max_tokens?: number },
  ): Promise<LLMResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('LLM call timed out')), this.timeout)

      this.provider
        .call(messages, options)
        .then((res) => {
          clearTimeout(timer)
          resolve(res)
        })
        .catch((err) => {
          clearTimeout(timer)
          reject(err)
        })
    })
  }
}
