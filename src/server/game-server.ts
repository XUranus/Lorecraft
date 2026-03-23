import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { GameLoop } from '../interface/game-loop.js'
import type { GameEventListener } from '../interface/game-loop.js'
import type { GenesisDocument } from '../domain/models/genesis.js'
import type { PlayerAttributes } from '../domain/models/attributes.js'
import type { AttributeCheckResult } from '../orchestration/steps/arbitration-steps.js'
import { ClientMessageSchema } from './protocol.js'
import type { ServerMessage } from './protocol.js'

// ============================================================
// WsBridge — forwards GameEventListener calls to a WebSocket
// ============================================================

/** Message types worth replaying on reconnect */
const HISTORY_TYPES = new Set([
  'narrative', 'voices', 'check', 'status', 'init_progress',
  'init_complete', 'char_create', 'error', 'save_result', 'save_error',
])

class WsBridge implements GameEventListener {
  private ws: WebSocket | null = null
  private _history: ServerMessage[] = []

  attach(ws: WebSocket): void {
    this.ws = ws
  }

  detach(): void {
    this.ws = null
  }

  /** Only detach if the given ws is still the active connection */
  detachIf(ws: WebSocket): void {
    if (this.ws === ws) {
      this.ws = null
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  get history(): ServerMessage[] {
    return this._history
  }

  clearHistory(): void {
    this._history = []
  }

  removeFromHistory(type: string): void {
    this._history = this._history.filter((m) => m.type !== type)
  }

  send(msg: ServerMessage): void {
    if (HISTORY_TYPES.has(msg.type)) {
      this._history.push(msg)
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Send a message without recording it in history */
  sendDirect(msg: ServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  onNarrative(text: string, source: string): void {
    this.send({ type: 'narrative', text, source })
  }

  onVoices(voices: Array<{ trait_id: string; line: string }>): void {
    this.send({ type: 'voices', voices })
  }

  onStatus(location: string, turn: number): void {
    this.send({ type: 'status', location, turn })
  }

  onError(message: string): void {
    this.send({ type: 'error', message })
  }

  onInitProgress(step: string): void {
    this.send({ type: 'init_progress', step })
  }

  onInitComplete(doc: GenesisDocument): void {
    this.send({ type: 'init_complete', doc })
  }

  onInsistencePrompt(): void {
    this.send({ type: 'insistence_prompt' })
  }

  onCheck(check: AttributeCheckResult): void {
    if (check.needed && check.attribute_display_name != null) {
      this.send({
        type: 'check',
        attribute: check.attribute_display_name,
        target: check.target!,
        roll: check.roll!,
        attribute_value: check.attribute_value!,
        total: check.total!,
        passed: check.passed!,
      })
    }
  }

  onCharCreate(attributes: PlayerAttributes, meta: Array<{ id: string; display_name: string; domain: string }>): void {
    this.send({ type: 'char_create', attributes: attributes as unknown as Record<string, number>, attribute_meta: meta })
  }

  onDebugTurnStart(turn: number, input: string): void {
    this.send({ type: 'debug_turn_start', turn, input })
  }

  onDebugStep(step: string, phase: 'start' | 'end', status?: string, duration_ms?: number, data?: string): void {
    this.send({ type: 'debug_step', step, phase, status, duration_ms, data })
  }

  onDebugState(states: Record<string, unknown>): void {
    this.send({ type: 'debug_state', states })
  }
}

// ============================================================
// GameServer — persistent game session, clients come and go
// ============================================================

export const DEFAULT_PORT = 3015

export interface GameServerOptions {
  port: number
  provider: ILLMProvider
  debug?: boolean | string
}

export class GameServer {
  private wss: WebSocketServer | null = null
  private readonly options: GameServerOptions

  // Single persistent game session
  private gameLoop: GameLoop
  private bridge: WsBridge
  private initialized = false
  private initializing = false
  private genesisDoc: GenesisDocument | null = null
  private pendingInsistInput: string | null = null

  constructor(options: GameServerOptions) {
    this.options = options
    this.bridge = new WsBridge()
    this.gameLoop = new GameLoop(options.provider, options.debug ? { debug: options.debug } : undefined)
    this.gameLoop.setListener(this.bridge)
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.options.port })

      // Intercept onInitComplete to cache the genesis doc
      const originalOnInitComplete = this.bridge.onInitComplete.bind(this.bridge)
      this.bridge.onInitComplete = (doc: GenesisDocument) => {
        this.genesisDoc = doc
        originalOnInitComplete(doc)
      }

      this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
        // Detach previous client if any (safe: won't affect new ws)
        this.bridge.detach()
        this.bridge.attach(ws)

        // Don't send history here — wait for client's 'initialize' message
        // to avoid race condition with old ws close event

        ws.on('message', async (data) => {
          try {
            await this.handleMessage(data.toString())
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.bridge.send({ type: 'error', message: msg })
          }
        })

        ws.on('close', () => {
          this.bridge.detachIf(ws)
        })

        ws.on('error', () => {
          this.bridge.detachIf(ws)
        })
      })

      this.wss.on('listening', () => {
        resolve()
      })
    })
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg
    try {
      msg = ClientMessageSchema.parse(JSON.parse(raw))
    } catch {
      this.bridge.send({ type: 'error', message: '无效的消息格式' })
      return
    }

    switch (msg.type) {
      case 'ping':
        this.bridge.send({ type: 'pong' })
        break

      case 'initialize':
        if (this.initialized || this.gameLoop.isAwaitingCharConfirm) {
          // Already in progress or done — replay history instead of re-initializing
          if (this.bridge.history.length > 0) {
            this.bridge.sendDirect({ type: 'history', messages: this.bridge.history })
          }
          if (this.gameLoop.isAwaitingCharConfirm) {
            this.gameLoop.rerollAttributes()
          }
          return
        }
        if (this.initializing) {
          // Initialization already in progress (e.g. client reconnected) — ignore
          this.bridge.send({ type: 'init_progress', step: '正在初始化，请稍候…' })
          return
        }
        this.initializing = true
        try {
          await this.gameLoop.initialize()
          // Don't set initialized=true yet — waiting for confirm_attributes
        } catch (err) {
          this.bridge.send({
            type: 'error',
            message: `初始化失败: ${err instanceof Error ? err.message : String(err)}`,
          })
        } finally {
          this.initializing = false
        }
        break

      case 'reroll_attributes':
        if (!this.gameLoop.isAwaitingCharConfirm) {
          this.bridge.send({ type: 'error', message: '当前不在角色创建阶段' })
          return
        }
        this.gameLoop.rerollAttributes()
        break

      case 'confirm_attributes':
        if (!this.gameLoop.isAwaitingCharConfirm) {
          this.bridge.send({ type: 'error', message: '当前不在角色创建阶段' })
          return
        }
        try {
          await this.gameLoop.confirmAttributes(msg.attributes as unknown as PlayerAttributes)
          this.initialized = true
          // Char creation is done — remove char_create from history so reconnect won't re-show overlay
          this.bridge.removeFromHistory('char_create')
        } catch (err) {
          this.bridge.send({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
        break

      case 'input':
        if (!this.initialized) {
          this.bridge.send({ type: 'error', message: '游戏尚未初始化' })
          return
        }
        await this.gameLoop.processInput(msg.text)
        break

      case 'save':
        try {
          const saveId = await this.gameLoop.save()
          this.bridge.send({ type: 'save_result', saveId })
        } catch (err) {
          this.bridge.send({
            type: 'save_error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
        break

      case 'reset':
        this.gameLoop.reset()
        this.initialized = false
        this.initializing = false
        this.genesisDoc = null
        this.bridge.clearHistory()
        this.pendingInsistInput = null
        this.bridge.send({ type: 'reset_complete' })
        break

      case 'insist':
        if (!this.gameLoop.isAwaitingInsist) {
          this.bridge.send({ type: 'error', message: '当前没有待确认的行动' })
          return
        }
        await this.gameLoop.insist()
        break

      case 'abandon':
        if (!this.gameLoop.isAwaitingInsist) {
          return
        }
        this.gameLoop.abandon()
        this.bridge.send({ type: 'narrative', text: '你改变了主意。', source: 'system' })
        break
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve()
        return
      }
      this.bridge.detach()
      this.wss.close(() => resolve())
    })
  }

  get port(): number {
    return this.options.port
  }
}
