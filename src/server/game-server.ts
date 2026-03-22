import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { GameLoop } from '../interface/game-loop.js'
import type { GameEventListener } from '../interface/game-loop.js'
import type { GenesisDocument } from '../domain/models/genesis.js'
import { ClientMessageSchema } from './protocol.js'
import type { ServerMessage } from './protocol.js'

// ============================================================
// WsBridge — forwards GameEventListener calls to a WebSocket
// ============================================================

class WsBridge implements GameEventListener {
  private ws: WebSocket | null = null

  attach(ws: WebSocket): void {
    this.ws = ws
  }

  detach(): void {
    this.ws = null
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  send(msg: ServerMessage): void {
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
  private genesisDoc: GenesisDocument | null = null

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
        // Detach previous client if any
        this.bridge.detach()
        this.bridge.attach(ws)

        // If game is already initialized, replay state to the new client
        if (this.initialized && this.genesisDoc) {
          this.bridge.send({ type: 'init_complete', doc: this.genesisDoc })
          // Replay current status
          const state = this.gameLoop.getGameState()
          if (state) {
            this.bridge.send({ type: 'status', location: state.currentLocation, turn: state.currentTurn })
          }
        }

        ws.on('message', async (data) => {
          try {
            await this.handleMessage(data.toString())
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.bridge.send({ type: 'error', message: msg })
          }
        })

        ws.on('close', () => {
          this.bridge.detach()
        })

        ws.on('error', () => {
          this.bridge.detach()
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
        if (this.initialized) {
          // Already initialized — just replay state
          if (this.genesisDoc) {
            this.bridge.send({ type: 'init_complete', doc: this.genesisDoc })
            const state = this.gameLoop.getGameState()
            if (state) {
              this.bridge.send({ type: 'status', location: state.currentLocation, turn: state.currentTurn })
            }
          }
          return
        }
        try {
          await this.gameLoop.initialize()
          this.initialized = true
        } catch (err) {
          this.bridge.send({
            type: 'error',
            message: `初始化失败: ${err instanceof Error ? err.message : String(err)}`,
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
