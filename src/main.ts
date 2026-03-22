#!/usr/bin/env node

import type { ILLMProvider } from './ai/runner/llm-provider.js'
import { AnthropicProvider } from './ai/runner/anthropic-provider.js'
import { GeminiProvider } from './ai/runner/gemini-provider.js'
import { TUIApp } from './interface/tui.js'

// ============================================================
// Provider Selection
// ============================================================

function createProvider(): ILLMProvider {
  const providerName = process.env.LLM_PROVIDER?.toLowerCase() ?? 'auto'

  if (providerName === 'gemini' || providerName === 'google') {
    return new GeminiProvider(
      process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
      process.env.GEMINI_MODEL,
    )
  }

  if (providerName === 'anthropic' || providerName === 'claude') {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      console.error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic')
      process.exit(1)
    }
    return new AnthropicProvider({ apiKey: key, model: process.env.ANTHROPIC_MODEL })
  }

  // Auto-detect based on available API keys
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return new GeminiProvider()
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL,
    })
  }

  console.error('No API key found. Set one of:')
  console.error('  GEMINI_API_KEY or GOOGLE_API_KEY  (for Google Gemini)')
  console.error('  ANTHROPIC_API_KEY                 (for Anthropic Claude)')
  console.error('')
  console.error('Optionally set LLM_PROVIDER=gemini|anthropic to force a provider.')
  process.exit(1)
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const provider = createProvider()
  const app = new TUIApp(provider)
  await app.start()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
