import blessed from 'blessed'
import type { GameEventListener } from './game-loop.js'
import { GameLoop } from './game-loop.js'
import type { ILLMProvider } from '../ai/runner/llm-provider.js'
import type { GenesisDocument } from '../domain/models/genesis.js'

// ============================================================
// Color Palette
// ============================================================

const COLORS = {
  bg: 'black',
  fg: '#c0c0c0',
  border: '#444444',
  title: '#e0a040',
  narrative: '#d0d0d0',
  voice: '#70a0d0',
  input: '#e0e0e0',
  status: '#808080',
  error: '#d04040',
  system: '#60a060',
  highlight: '#e0c070',
}

// ============================================================
// TUI Application
// ============================================================

export class TUIApp implements GameEventListener {
  private screen: blessed.Widgets.Screen
  private narrativeBox: blessed.Widgets.BoxElement
  private voiceBox: blessed.Widgets.BoxElement
  private inputBox: blessed.Widgets.TextboxElement
  private statusBar: blessed.Widgets.BoxElement
  private helpBar: blessed.Widgets.BoxElement
  private gameLoop: GameLoop
  private narrativeLines: string[] = []
  private voiceLines: string[] = []
  private isProcessing = false

  constructor(provider: ILLMProvider) {
    this.gameLoop = new GameLoop(provider)
    this.gameLoop.setListener(this)

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Lorecraft',
      cursor: { shape: 'line', blink: true, color: COLORS.highlight, artificial: true },
    })

    // Title bar
    const titleBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: ' ⚔  LORECRAFT ',
      style: {
        fg: COLORS.title,
        bg: '#1a1a1a',
        bold: true,
      },
    })

    // Narrative panel (main area, left side)
    this.narrativeBox = blessed.box({
      parent: this.screen,
      label: ' 叙事 ',
      top: 1,
      left: 0,
      width: '75%',
      height: '100%-5',
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        style: { bg: '#333333' },
      },
      keys: true,
      mouse: true,
      border: { type: 'line' },
      style: {
        fg: COLORS.narrative,
        bg: COLORS.bg,
        border: { fg: COLORS.border },
        label: { fg: COLORS.title, bold: true },
        scrollbar: { bg: '#333333' },
      },
      tags: true,
      padding: { left: 1, right: 1 },
    })

    // Voice panel (right side, inner voices)
    this.voiceBox = blessed.box({
      parent: this.screen,
      label: ' 内心声音 ',
      top: 1,
      right: 0,
      width: '25%',
      height: '100%-5',
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      mouse: true,
      border: { type: 'line' },
      style: {
        fg: COLORS.voice,
        bg: COLORS.bg,
        border: { fg: COLORS.border },
        label: { fg: COLORS.voice, bold: true },
      },
      tags: true,
      padding: { left: 1, right: 1 },
    })

    // Input box (bottom)
    this.inputBox = blessed.textbox({
      parent: this.screen,
      label: ' 输入 ',
      bottom: 1,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      style: {
        fg: COLORS.input,
        bg: '#0a0a0a',
        border: { fg: COLORS.border },
        label: { fg: COLORS.highlight, bold: true },
      },
      inputOnFocus: true,
      keys: true,
      mouse: true,
      padding: { left: 1 },
    })

    // Status bar (very bottom)
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 4,
      left: 0,
      width: '75%',
      height: 1,
      content: '',
      style: {
        fg: COLORS.status,
        bg: '#111111',
      },
      padding: { left: 1 },
    })

    // Help bar
    this.helpBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: ' {bold}Enter{/bold} 发送 | {bold}Esc/q{/bold} 退出 | {bold}Ctrl+S{/bold} 存档 | {bold}↑↓{/bold} 滚动',
      style: {
        fg: '#606060',
        bg: '#0a0a0a',
      },
      tags: true,
    })

    // Key bindings
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.shutdown()
    })

    this.screen.key(['C-s'], async () => {
      await this.saveGame()
    })

    // Input submission
    this.inputBox.on('submit', async (value: string) => {
      await this.handleInput(value)
    })

    // Focus input on click
    this.narrativeBox.on('click', () => {
      this.inputBox.focus()
    })

    this.screen.render()
  }

  // ---- Public API ----

  async start(): Promise<void> {
    this.appendNarrative('{bold}{#60a060-fg}正在初始化游戏世界，请稍候…{/}')
    this.screen.render()

    try {
      await this.gameLoop.initialize()
      this.focusInput()
    } catch (err) {
      this.appendNarrative(`{bold}{#d04040-fg}初始化失败: ${err instanceof Error ? err.message : String(err)}{/}`)
      this.screen.render()
    }
  }

  // ---- GameEventListener Implementation ----

  onNarrative(text: string, source: string): void {
    const prefix = this.getSourcePrefix(source)
    this.appendNarrative(`${prefix}${this.escapeTag(text)}`)
    this.screen.render()
  }

  onVoices(voices: Array<{ trait_id: string; line: string }>): void {
    for (const voice of voices) {
      this.voiceLines.push(`{bold}{#70a0d0-fg}[${this.escapeTag(voice.trait_id)}]{/}`)
      this.voiceLines.push(this.escapeTag(voice.line))
      this.voiceLines.push('')
    }
    this.voiceBox.setContent(this.voiceLines.join('\n'))
    this.voiceBox.setScrollPerc(100)
    this.screen.render()
  }

  onStatus(location: string, turn: number): void {
    this.statusBar.setContent(
      ` 📍 ${location}  |  ⏳ 第 ${turn} 轮`,
    )
    this.screen.render()
  }

  onError(message: string): void {
    this.appendNarrative(`{bold}{#d04040-fg}[错误] ${this.escapeTag(message)}{/}`)
    this.screen.render()
  }

  onInitProgress(step: string): void {
    this.appendNarrative(`{#60a060-fg}${this.escapeTag(step)}{/}`)
    this.screen.render()
  }

  onInitComplete(doc: GenesisDocument): void {
    this.appendNarrative('')
    this.appendNarrative(`{bold}{#e0a040-fg}═══ ${this.escapeTag(doc.world_setting.tone)} ═══{/}`)
    this.appendNarrative('')
    this.appendNarrative(`{#808080-fg}${this.escapeTag(doc.world_setting.background)}{/}`)
    this.appendNarrative('')
    this.appendNarrative(`{#60a060-fg}你是 ${this.escapeTag(doc.characters.player_character.name)}。${this.escapeTag(doc.characters.player_character.background)}{/}`)
    this.appendNarrative('')
    this.appendNarrative('{bold}{#e0a040-fg}─────────────────────────────{/}')
    this.appendNarrative('')
    this.screen.render()
  }

  // ---- Private Helpers ----

  private async handleInput(value: string): Promise<void> {
    const input = value.trim()
    if (!input || this.isProcessing) {
      this.focusInput()
      return
    }

    // Show player input
    this.appendNarrative(`{bold}{#e0c070-fg}> ${this.escapeTag(input)}{/}`)
    this.appendNarrative('')
    this.screen.render()

    this.isProcessing = true
    this.inputBox.clearValue()
    this.inputBox.setLabel(' 处理中… ')
    this.screen.render()

    try {
      await this.gameLoop.processInput(input)
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err))
    }

    this.isProcessing = false
    this.inputBox.setLabel(' 输入 ')
    this.appendNarrative('')
    this.focusInput()
  }

  private async saveGame(): Promise<void> {
    try {
      const saveId = await this.gameLoop.save()
      this.appendNarrative(`{#60a060-fg}[系统] 存档成功: ${saveId.slice(0, 8)}…{/}`)
    } catch (err) {
      this.appendNarrative(`{#d04040-fg}[系统] 存档失败: ${err instanceof Error ? err.message : String(err)}{/}`)
    }
    this.screen.render()
  }

  private appendNarrative(line: string): void {
    this.narrativeLines.push(line)
    this.narrativeBox.setContent(this.narrativeLines.join('\n'))
    this.narrativeBox.setScrollPerc(100)
  }

  private focusInput(): void {
    this.inputBox.clearValue()
    this.inputBox.focus()
    this.screen.render()
  }

  private getSourcePrefix(source: string): string {
    switch (source) {
      case 'event':
        return ''
      case 'rejection':
        return '{#808080-fg}[旁白] {/}'
      case 'inciting_event':
        return '{bold}{#e0a040-fg}[序幕] {/}'
      default:
        return ''
    }
  }

  private escapeTag(str: string): string {
    // Escape blessed tag syntax in user content
    return str.replace(/\{/g, '\\{').replace(/\}/g, '\\}')
  }

  private shutdown(): void {
    this.screen.destroy()
    process.exit(0)
  }
}
