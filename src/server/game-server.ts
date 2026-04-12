import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import { FileDebugLogger } from '../ai/runner/file-debug-logger.js'
import { SQLiteStore } from '../infrastructure/storage/sqlite-store.js'
import { GameLoop } from '../engine/game-loop.js'
import type { GameEventListener } from '../engine/game-loop.js'
import type { GenesisDocument } from '../domain/models/genesis.js'
import type { PlayerAttributes } from '../domain/models/attributes.js'
import type { AttributeCheckResult } from '../orchestration/steps/arbitration-steps.js'
import { STYLE_PRESETS } from '../domain/services/extension-config.js'
import type { StyleConfig } from '../domain/services/extension-config.js'
import { ClientMessageSchema } from './protocol.js'
import type { ServerMessage } from './protocol.js'
import { loadLLMConfig, detectEnvConfig, saveLLMConfig, createProviderFromConfig, testLLMConnection, listModels } from './llm-config.js'
import type { LLMConfig } from './llm-config.js'

// ============================================================
// Static file serving
// ============================================================

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(__dirname, '..', '..', 'web', 'dist')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let filePath = req.url === '/' ? '/index.html' : req.url ?? '/index.html'
  filePath = filePath.split('?')[0]

  if (filePath.includes('..')) {
    res.writeHead(403)
    res.end()
    return
  }

  const fullPath = join(PUBLIC_DIR, filePath)
  const ext = extname(fullPath)
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

  try {
    const data = await readFile(fullPath)
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(data)
  } catch {
    // SPA fallback: serve index.html for unknown routes
    try {
      const indexData = await readFile(join(PUBLIC_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(indexData)
    } catch {
      res.writeHead(404)
      res.end('Not Found')
    }
  }
}

// ============================================================
// Message types to persist for session restore
// ============================================================

const PERSIST_TYPES = new Set([
  'narrative', 'voices', 'check', 'status', 'init_progress',
  'init_complete', 'char_create', 'error', 'save_result', 'save_error',
])

// ============================================================
// AppServer — single-process monolithic server
// ============================================================

export const DEFAULT_PORT = 3016

export interface AppServerOptions {
  port: number
  provider: ILLMProvider
  debug?: boolean | string
  dbPath?: string
}

export class AppServer implements GameEventListener {
  private httpServer: ReturnType<typeof createServer> | null = null
  private wss: WebSocketServer | null = null
  private ws: WebSocket | null = null
  private readonly options: AppServerOptions

  // Game engine
  private gameLoop: GameLoop
  private initialized = false
  private initializing = false
  private genesisDoc: GenesisDocument | null = null

  // Session message history (persisted to DB)
  private sessionMessages: ServerMessage[] = []

  constructor(options: AppServerOptions) {
    this.options = options
    const store = new SQLiteStore(options.dbPath ?? ':memory:')
    const debugLogger = options.debug
      ? new FileDebugLogger(typeof options.debug === 'string' ? options.debug : './debug.log')
      : undefined
    this.gameLoop = new GameLoop(store, options.provider, { debugLogger })
    this.gameLoop.setListener(this)
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      // HTTP server for static files
      this.httpServer = createServer((req, res) => serveStatic(req, res))

      // WebSocket server attached to the same HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer })

      this.wss.on('connection', (ws: WebSocket) => {
        // Close previous client if any
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close()
        }
        this.ws = ws

        ws.on('message', async (data) => {
          try {
            await this.handleMessage(data.toString())
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.send({ type: 'error', message: msg })
          }
        })

        ws.on('close', () => {
          if (this.ws === ws) {
            this.ws = null
          }
        })

        ws.on('error', () => {
          if (this.ws === ws) {
            this.ws = null
          }
        })
      })

      this.httpServer.listen(this.options.port, () => resolve())
    })
  }

  // ============================================================
  // GameEventListener implementation
  // ============================================================

  onNarrative(text: string, source: string): void {
    this.send({ type: 'narrative', text, source })
  }

  onVoices(voices: Array<{ trait_id: string; line: string }>): void {
    this.send({ type: 'voices', voices })
  }

  onStatus(location: string, turn: number): void {
    this.send({ type: 'status', location, turn })
  }

  onError(message: string, retryable?: boolean): void {
    this.send({ type: 'error', message, retryable: retryable ?? false })
  }

  onInitProgress(step: string | { key: string; params?: Record<string, string | number> }): void {
    // Server side: resolve structured messages to English fallback
    const text = typeof step === 'string' ? step : `[${step.key}]${step.params ? ' ' + JSON.stringify(step.params) : ''}`
    this.send({ type: 'init_progress', step: text })
  }

  onInitComplete(doc: GenesisDocument): void {
    this.genesisDoc = doc
    this.send({ type: 'init_complete', doc })
  }

  onStyleSelect(presets: Array<{ label: string; description: string }>): void {
    this.send({ type: 'style_select', presets })
  }

  onInsistencePrompt(): void {
    this.send({ type: 'insistence_prompt' })
  }

  onCheck(check: AttributeCheckResult): void {
    if (check.needed && check.attribute_display_name != null) {
      this.send({
        type: 'check',
        attribute: check.attribute_display_name,
        difficulty: check.difficulty ?? 'ROUTINE',
        base_target: check.base_target ?? check.target!,
        modifiers: check.modifiers ?? [],
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

  // ============================================================
  // Send helper
  // ============================================================

  private send(msg: ServerMessage): void {
    if (PERSIST_TYPES.has(msg.type)) {
      this.sessionMessages.push(msg)
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Send without recording in session history */
  private sendDirect(msg: ServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  // ============================================================
  // Message handling
  // ============================================================

  private async handleMessage(raw: string): Promise<void> {
    let msg
    try {
      msg = ClientMessageSchema.parse(JSON.parse(raw))
    } catch {
      this.send({ type: 'error', message: 'Invalid message format' })
      return
    }

    switch (msg.type) {
      case 'ping':
        this.sendDirect({ type: 'pong' })
        break

      case 'initialize':
        if (this.initialized || this.gameLoop.isAwaitingCharConfirm) {
          // Replay session history from memory
          if (this.sessionMessages.length > 0) {
            this.sendDirect({ type: 'history', messages: this.sessionMessages })
          }
          if (this.gameLoop.isAwaitingCharConfirm) {
            this.gameLoop.rerollAttributes()
          }
          return
        }
        if (this.gameLoop.isAwaitingStyleSelect) {
          this.sendDirect({ type: 'style_select', presets: STYLE_PRESETS.map(p => ({ label: p.label, description: p.description })) })
          return
        }
        if (this.initializing) {
          this.send({ type: 'init_progress', step: 'Initializing, please wait…' })
          return
        }
        // Check for existing sessions
        {
          const sessions = this.gameLoop.listSessions()
          if (sessions.length > 0) {
            this.sendDirect({
              type: 'session_list',
              sessions: sessions.map((s) => ({
                id: s.id, label: s.label, turn: s.turn,
                location: s.location, updated_at: s.updated_at,
              })),
            })
            return
          }
        }
        this.send({ type: 'no_game' })
        break

      case 'new_game':
        if (this.initialized || this.initializing) {
          this.send({ type: 'error', message: 'Game already in progress, please reset first' })
          return
        }
        await this.gameLoop.initialize()
        break

      case 'select_style': {
        if (!this.gameLoop.isAwaitingStyleSelect) {
          this.send({ type: 'error', message: 'Not in style selection phase' })
          return
        }
        const idx = msg.preset_index
        if (idx === -1) {
          const randomIdx = Math.floor(Math.random() * STYLE_PRESETS.length)
          const style = STYLE_PRESETS[randomIdx]
          this.startGeneration({ tone: style.tone, complexity: style.complexity, narrative_style: style.narrative_style, player_archetype: style.player_archetype })
        } else if (idx >= 0 && idx < STYLE_PRESETS.length) {
          const style = STYLE_PRESETS[idx]
          this.startGeneration({ tone: style.tone, complexity: style.complexity, narrative_style: style.narrative_style, player_archetype: style.player_archetype })
        } else {
          this.send({ type: 'error', message: 'Invalid preset index' })
        }
        break
      }

      case 'select_style_custom':
        if (!this.gameLoop.isAwaitingStyleSelect) {
          this.send({ type: 'error', message: 'Not in style selection phase' })
          return
        }
        this.startGeneration({
          tone: msg.tone,
          complexity: 'MEDIUM',
          narrative_style: msg.narrative_style,
          player_archetype: msg.player_archetype,
        })
        break

      case 'reroll_attributes':
        if (!this.gameLoop.isAwaitingCharConfirm) {
          this.send({ type: 'error', message: 'Not in character creation phase' })
          return
        }
        this.gameLoop.rerollAttributes()
        break

      case 'confirm_attributes':
        if (!this.gameLoop.isAwaitingCharConfirm) {
          this.send({ type: 'error', message: 'Not in character creation phase' })
          return
        }
        try {
          await this.gameLoop.confirmAttributes(msg.attributes as unknown as PlayerAttributes)
          this.initialized = true
          // Remove char_create from history so reconnect won't re-show overlay
          this.sessionMessages = this.sessionMessages.filter((m) => m.type !== 'char_create')
          await this.gameLoop.saveSessionHistory(this.sessionMessages)
        } catch (err) {
          this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
        break

      case 'input':
        if (!this.initialized) {
          this.send({ type: 'error', message: 'Game not initialized' })
          return
        }
        await this.gameLoop.processInput(msg.text)
        await this.gameLoop.saveSessionHistory(this.sessionMessages)
        break

      case 'save':
        try {
          const saveId = await this.gameLoop.save()
          this.send({ type: 'save_result', saveId })
        } catch (err) {
          this.send({ type: 'save_error', message: err instanceof Error ? err.message : String(err) })
        }
        break

      case 'reset':
        this.gameLoop.reset()
        this.initialized = false
        this.initializing = false
        this.genesisDoc = null
        this.sessionMessages = []
        this.send({ type: 'reset_complete' })
        break

      case 'insist':
        if (!this.gameLoop.isAwaitingInsist) {
          this.send({ type: 'error', message: 'No pending action to confirm' })
          return
        }
        await this.gameLoop.insist()
        break

      case 'abandon':
        if (!this.gameLoop.isAwaitingInsist) return
        this.gameLoop.abandon()
        this.send({ type: 'narrative', text: 'You changed your mind.', source: 'system' })
        break

      case 'retry':
        await this.gameLoop.retry()
        break

      case 'get_characters': {
        const info = await this.gameLoop.getCharacterInfo()
        if (info) {
          this.sendDirect({ type: 'characters', player: info.player, npcs: info.npcs })
        } else {
          this.send({ type: 'error', message: 'Game not initialized' })
        }
        break
      }

      // Session management
      case 'list_sessions':
        this.sendDirect({
          type: 'session_list',
          sessions: this.gameLoop.listSessions().map((s) => ({
            id: s.id, label: s.label, turn: s.turn,
            location: s.location, updated_at: s.updated_at,
          })),
        })
        break

      case 'new_session':
        this.gameLoop.reset()
        this.initialized = false
        this.initializing = false
        this.genesisDoc = null
        this.sessionMessages = []
        this.send({ type: 'reset_complete' })
        break

      case 'switch_session': {
        await this.gameLoop.saveSessionHistory(this.sessionMessages)

        const switched = await this.gameLoop.switchSession(msg.session_id)
        if (!switched) {
          this.send({ type: 'error', message: 'Cannot switch to that save' })
          return
        }

        this.initialized = true
        this.initializing = false
        const gs = this.gameLoop.getGameState()
        if (gs) {
          this.genesisDoc = gs.genesisDoc
        }

        const savedHistory = await this.gameLoop.loadSessionHistory(msg.session_id)
        if (savedHistory && savedHistory.length > 0) {
          this.sessionMessages = savedHistory as ServerMessage[]
          this.sendDirect({ type: 'history', messages: this.sessionMessages })
        } else {
          this.sessionMessages = []
          if (gs) {
            this.send({ type: 'init_complete', doc: gs.genesisDoc })
            this.send({ type: 'status', location: gs.currentLocation, turn: gs.currentTurn })
            this.send({ type: 'narrative', text: `Loaded save: ${gs.currentLocation}, Turn ${gs.currentTurn}`, source: 'system' })
          }
        }
        break
      }

      case 'delete_session':
        this.gameLoop.deleteSession(msg.session_id)
        this.sendDirect({
          type: 'session_list',
          sessions: this.gameLoop.listSessions().map((s) => ({
            id: s.id, label: s.label, turn: s.turn,
            location: s.location, updated_at: s.updated_at,
          })),
        })
        break

      case 'get_llm_config': {
        const config = loadLLMConfig() ?? detectEnvConfig()
        if (config) {
          this.sendDirect({ type: 'llm_config', config })
        } else {
          this.sendDirect({ type: 'llm_config', config: { provider: '', api_key: '', model: '' } })
        }
        break
      }

      case 'set_llm_config': {
        const newConfig: LLMConfig = {
          provider: msg.provider,
          api_key: msg.api_key,
          model: msg.model,
          base_url: msg.base_url,
        }
        try {
          const newProvider = createProviderFromConfig(newConfig)
          saveLLMConfig(newConfig)
          this.gameLoop.setProvider(newProvider)
          this.sendDirect({ type: 'llm_config_saved' })
        } catch (err) {
          this.send({ type: 'error', message: `Invalid configuration: ${err instanceof Error ? err.message : String(err)}` })
        }
        break
      }

      case 'test_llm_config': {
        const testConfig: LLMConfig = {
          provider: msg.provider,
          api_key: msg.api_key,
          model: msg.model,
          base_url: msg.base_url,
        }
        testLLMConnection(testConfig).then((result) => {
          this.sendDirect({ type: 'llm_test_result', ...result })
        })
        break
      }

      case 'list_models':
        listModels({ provider: msg.provider, api_key: msg.api_key, base_url: msg.base_url })
          .then((models) => {
            this.sendDirect({ type: 'model_list', models })
          })
          .catch((err) => {
            this.send({ type: 'error', message: `Failed to fetch model list: ${err instanceof Error ? err.message : String(err)}` })
          })
        break
    }
  }

  private async startGeneration(style: StyleConfig): Promise<void> {
    this.initializing = true
    try {
      await this.gameLoop.selectStyle(style)
    } catch (err) {
      this.send({ type: 'error', message: `Initialization failed: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      this.initializing = false
    }
  }

  setProvider(provider: ILLMProvider): void {
    this.gameLoop.setProvider(provider)
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.ws?.close()
      this.ws = null
      if (this.httpServer) {
        this.httpServer.close(() => resolve())
      } else {
        resolve()
      }
    })
  }

  get port(): number {
    return this.options.port
  }
}
