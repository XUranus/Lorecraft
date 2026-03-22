// ============================================================
// Lorecraft Web Client
// ============================================================

const WS_PORT = window.__LORECRAFT_WS_PORT__ || 3015
const WS_URL = `ws://${location.hostname}:${WS_PORT}`

const narrativeEl = document.getElementById('narrative-content')
const voiceEl = document.getElementById('voice-content')
const statusBar = document.getElementById('status-bar')
const inputBox = document.getElementById('input-box')
const sendBtn = document.getElementById('send-btn')
const inputForm = document.getElementById('input-form')
const connDot = document.getElementById('connection-status')

let ws = null
let isProcessing = false

// ---- WebSocket Connection ----

function connect() {
  setConnectionStatus('connecting')
  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    setConnectionStatus('connected')
    appendNarrative('已连接到服务器…', 'system')
    ws.send(JSON.stringify({ type: 'initialize' }))  // Server will replay state if already initialized
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      handleMessage(msg)
    } catch { /* ignore */ }
  }

  ws.onclose = () => {
    setConnectionStatus('disconnected')
    setInputEnabled(false)
    appendNarrative('与服务器的连接已断开', 'error')
    // Auto-reconnect after 3s
    setTimeout(connect, 3000)
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function setConnectionStatus(state) {
  connDot.className = 'status-dot ' + state
}

// ---- Message Handling ----

function handleMessage(msg) {
  switch (msg.type) {
    case 'narrative':
      onNarrative(msg.text, msg.source)
      break
    case 'voices':
      onVoices(msg.voices)
      break
    case 'status':
      onStatus(msg.location, msg.turn)
      break
    case 'error':
      onError(msg.message)
      break
    case 'init_progress':
      appendNarrative(msg.step, 'system')
      break
    case 'init_complete':
      onInitComplete(msg.doc)
      break
    case 'save_result':
      appendNarrative(`[系统] 存档成功: ${msg.saveId.slice(0, 8)}…`, 'system')
      break
    case 'save_error':
      appendNarrative(`[系统] 存档失败: ${msg.message}`, 'error')
      break
    case 'pong':
      break
  }
}

function onNarrative(text, source) {
  const cls = source === 'rejection' ? 'rejection'
    : source === 'inciting_event' ? 'inciting'
    : 'event'

  const prefix = source === 'rejection' ? '[旁白] '
    : source === 'inciting_event' ? '[序幕] '
    : ''

  appendNarrative(prefix + text, cls)

  if (isProcessing) {
    isProcessing = false
    setInputEnabled(true)
  }
}

function onVoices(voices) {
  for (const v of voices) {
    const entry = document.createElement('div')
    entry.className = 'voice-entry'
    entry.innerHTML = `<div class="voice-trait">[${esc(v.trait_id)}]</div><div class="voice-line">${esc(v.line)}</div>`
    voiceEl.appendChild(entry)
  }
  voiceEl.scrollTop = voiceEl.scrollHeight
}

function onStatus(location, turn) {
  statusBar.textContent = `📍 ${location}  |  ⏳ 第 ${turn} 轮`
}

function onError(message) {
  appendNarrative(`[错误] ${message}`, 'error')
  if (isProcessing) {
    isProcessing = false
    setInputEnabled(true)
  }
}

function onInitComplete(doc) {
  if (!doc) return
  const ws = doc.world_setting || {}
  const pc = (doc.characters || {}).player_character || {}

  appendNarrative('', 'spacer')
  appendNarrative(`═══ ${ws.tone || ''} ═══`, 'world-title')
  appendNarrative('', 'spacer')
  appendNarrative(ws.background || '', 'world-bg')
  appendNarrative('', 'spacer')
  appendNarrative(`你是 ${pc.name || ''}。${pc.background || ''}`, 'player-intro')
  appendNarrative('', 'spacer')
  appendNarrative('─────────────────────────────', 'separator')
  appendNarrative('', 'spacer')

  setInputEnabled(true)
  inputBox.focus()
}

// ---- Input ----

inputForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = inputBox.value.trim()
  if (!text || isProcessing) return

  appendNarrative(`> ${text}`, 'player-input')
  appendNarrative('', 'spacer')

  isProcessing = true
  setInputEnabled(false)
  send({ type: 'input', text })
  inputBox.value = ''
})

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault()
    send({ type: 'save' })
  }
})

function setInputEnabled(enabled) {
  inputBox.disabled = !enabled
  sendBtn.disabled = !enabled
  if (enabled) {
    inputBox.placeholder = '输入你的行动...'
    inputBox.focus()
  } else {
    inputBox.placeholder = isProcessing ? '处理中…' : '未连接'
  }
}

// ---- DOM Helpers ----

function appendNarrative(text, cls) {
  if (cls === 'spacer') {
    const spacer = document.createElement('div')
    spacer.className = 'narrative-line spacer'
    narrativeEl.appendChild(spacer)
  } else {
    const el = document.createElement('div')
    el.className = `narrative-line ${cls || ''}`
    el.textContent = text
    narrativeEl.appendChild(el)
  }
  narrativeEl.scrollTop = narrativeEl.scrollHeight
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

// ---- Start ----

connect()
