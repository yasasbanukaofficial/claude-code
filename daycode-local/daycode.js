#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startGeminiAnthropicProxy } from './geminiAnthropicProxy.js'

const daycodeHome = process.env.DAYCODE_CONFIG_DIR ?? join(homedir(), '.daycode')

if (!process.env.CLAUDE_CONFIG_DIR) {
  process.env.CLAUDE_CONFIG_DIR = daycodeHome
}

process.env.DAYCODE_BRAND = '1'

if (!existsSync(daycodeHome)) {
  mkdirSync(daycodeHome, { recursive: true })
}

async function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY?.trim()) {
    return process.env.GEMINI_API_KEY.trim()
  }

  const keyPath = join(daycodeHome, 'gemini.key')
  if (!existsSync(keyPath)) {
    return null
  }

  const value = await readFile(keyPath, 'utf8')
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const geminiApiKey = await loadGeminiApiKey()
if (geminiApiKey && process.env.DAYCODE_DISABLE_GEMINI_PROXY !== '1') {
  const { port } = await startGeminiAnthropicProxy({
    apiKey: geminiApiKey,
  })

  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  process.env.ANTHROPIC_API_KEY ||= 'daycode-gemini-proxy'
  process.env.DAYCODE_PROVIDER = 'gemini'
}

const currentDir = dirname(fileURLToPath(import.meta.url))
await import(join(currentDir, 'cli.js'))
