import http from 'node:http'
import { randomUUID } from 'node:crypto'

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

function sendAnthropicError(res, status, type, message, extraHeaders = {}) {
  sendJson(
    res,
    status,
    {
      type: 'error',
      error: {
        type,
        message,
      },
    },
    extraHeaders,
  )
}

function parseRetryAfterSeconds(message) {
  if (typeof message !== 'string') return undefined

  const match =
    message.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i) ||
    message.match(/in\s+([0-9]+(?:\.[0-9]+)?)s\./i)

  if (!match) return undefined

  const seconds = Math.ceil(Number(match[1]))
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function classifyGeminiError(error) {
  const statusCode = Number(error?.statusCode)
  const message = String(error?.message || 'Gemini proxy error')
  const lowered = message.toLowerCase()

  if (
    statusCode === 429 ||
    lowered.includes('quota exceeded') ||
    lowered.includes('rate limit') ||
    lowered.includes('resource exhausted')
  ) {
    return {
      status: 429,
      type: 'rate_limit_error',
      message,
      headers: {
        ...(parseRetryAfterSeconds(message)
          ? { 'retry-after': String(parseRetryAfterSeconds(message)) }
          : {}),
      },
    }
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      status: 401,
      type: 'authentication_error',
      message,
      headers: {},
    }
  }

  return {
    status: 500,
    type: 'api_error',
    message,
    headers: {},
  }
}

function flattenText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('content' in value) return flattenText(value.content)
    return JSON.stringify(value)
  }
  return String(value)
}

function normalizeSystemText(system) {
  if (!system) return ''
  return flattenText(system)
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block
        if (block?.type === 'text') return block.text ?? ''
        return flattenText(block)
      })
      .filter(Boolean)
      .join('\n')
  }
  return flattenText(content)
}

function mapAnthropicModelToGemini(model) {
  const override = process.env.DAYCODE_GEMINI_MODEL?.trim()
  if (override) return override
  const normalized = String(model || '').toLowerCase()
  if (normalized.includes('haiku')) return 'gemini-2.5-flash'
  if (normalized.includes('sonnet')) return 'gemini-2.5-flash'
  if (normalized.includes('opus')) return 'gemini-2.5-flash'
  return 'gemini-2.5-flash'
}

function mapToolChoice(toolChoice) {
  if (!toolChoice || !toolChoice.type) {
    return { mode: 'AUTO' }
  }
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      mode: 'ANY',
      allowedFunctionNames: [toolChoice.name],
    }
  }
  if (toolChoice.type === 'any') {
    return { mode: 'ANY' }
  }
  if (toolChoice.type === 'none') {
    return { mode: 'NONE' }
  }
  return { mode: 'AUTO' }
}

function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'OBJECT', properties: {} }
  }

  const rawType =
    typeof schema.type === 'string' ? schema.type.toLowerCase() : undefined

  if (rawType === 'object' || schema.properties || schema.additionalProperties) {
    const properties = {}
    for (const [key, value] of Object.entries(schema.properties || {})) {
      properties[key] = sanitizeSchemaForGemini(value)
    }

    const result = {
      type: 'OBJECT',
      properties,
    }

    if (Array.isArray(schema.required) && schema.required.length > 0) {
      result.required = schema.required.filter(name => typeof name === 'string')
    }

    return result
  }

  if (rawType === 'array' || schema.items) {
    return {
      type: 'ARRAY',
      items: sanitizeSchemaForGemini(schema.items || { type: 'string' }),
    }
  }

  if (rawType === 'boolean') return { type: 'BOOLEAN' }
  if (rawType === 'integer') return { type: 'INTEGER' }
  if (rawType === 'number') return { type: 'NUMBER' }

  if (Array.isArray(schema.enum) && schema.enum.every(v => typeof v === 'string')) {
    return {
      type: 'STRING',
      enum: schema.enum,
    }
  }

  return { type: 'STRING' }
}

function mapTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }
  return [
    {
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        parameters: sanitizeSchemaForGemini(
          tool.input_schema || {
            type: 'object',
            properties: {},
          },
        ),
      })),
    },
  ]
}

function mergeConsecutiveRoles(contents) {
  const merged = []
  for (const item of contents) {
    const last = merged.at(-1)
    if (last && last.role === item.role) {
      last.parts.push(...item.parts)
    } else {
      merged.push({
        role: item.role,
        parts: [...item.parts],
      })
    }
  }
  return merged
}

function anthropicMessagesToGemini(messages) {
  const toolNamesById = new Map()
  const contents = []

  for (const message of messages || []) {
    const role = message.role === 'assistant' ? 'model' : 'user'
    const rawContent =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : []

    const parts = []
    for (const block of rawContent) {
      if (!block) continue

      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.length > 0) {
          parts.push({ text: block.text })
        }
        continue
      }

      if (block.type === 'tool_use') {
        const args =
          typeof block.input === 'string'
            ? safeJsonParse(block.input, {})
            : (block.input ?? {})
        toolNamesById.set(block.id, block.name)
        parts.push({
          functionCall: {
            name: block.name,
            args,
          },
        })
        continue
      }

      if (block.type === 'tool_result') {
        const toolName =
          toolNamesById.get(block.tool_use_id) || `tool_${block.tool_use_id}`
        parts.push({
          functionResponse: {
            name: toolName,
            response: {
              tool_use_id: block.tool_use_id,
              is_error: block.is_error === true,
              content: normalizeToolResultContent(block.content),
            },
          },
        })
        continue
      }

      if (block.type === 'thinking') {
        continue
      }

      const fallback = flattenText(block)
      if (fallback) {
        parts.push({ text: fallback })
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return mergeConsecutiveRoles(contents)
}

function geminiUsageToAnthropic(usageMetadata) {
  return {
    input_tokens: usageMetadata?.promptTokenCount ?? 0,
    output_tokens: usageMetadata?.candidatesTokenCount ?? 0,
  }
}

function geminiFinishReasonToAnthropic(finishReason, hasToolUse) {
  if (finishReason === 'MAX_TOKENS') return 'max_tokens'
  if (hasToolUse) return 'tool_use'
  return 'end_turn'
}

function geminiPartsToAnthropicContent(parts) {
  const content = []
  let toolIndex = 0

  for (const part of parts || []) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      content.push({
        type: 'text',
        text: part.text,
      })
    }

    if (part.functionCall?.name) {
      content.push({
        type: 'tool_use',
        id: `toolu_${toolIndex++}_${randomUUID().replaceAll('-', '')}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      })
    }
  }

  return content
}

function buildAnthropicMessage(requestModel, geminiResponse) {
  const candidate = geminiResponse?.candidates?.[0]
  const parts = candidate?.content?.parts || []
  const content = geminiPartsToAnthropicContent(parts)
  const usage = geminiUsageToAnthropic(geminiResponse?.usageMetadata)
  const hasToolUse = content.some(block => block.type === 'tool_use')

  return {
    id: `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: geminiFinishReasonToAnthropic(candidate?.finishReason, hasToolUse),
    stop_sequence: null,
    usage,
  }
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function streamAnthropicMessage(res, message) {
  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      ...message,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
      },
    },
  })

  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: '',
        },
      })
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'text_delta',
          text: block.text,
        },
      })
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
      return
    }

    if (block.type === 'tool_use') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      })
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {}),
        },
      })
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      })
    }
  })

  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: message.usage.output_tokens,
    },
  })
  writeSseEvent(res, 'message_stop', {
    type: 'message_stop',
  })
  res.end()
}

async function callGemini(apiKey, requestBody) {
  const geminiModel = mapAnthropicModelToGemini(requestBody.model)
  const geminiBody = {
    contents: anthropicMessagesToGemini(requestBody.messages),
    ...(normalizeSystemText(requestBody.system)
      ? {
          systemInstruction: {
            parts: [{ text: normalizeSystemText(requestBody.system) }],
          },
        }
      : {}),
    ...(mapTools(requestBody.tools) ? { tools: mapTools(requestBody.tools) } : {}),
    ...(requestBody.tools?.length
      ? {
          toolConfig: {
            functionCallingConfig: mapToolChoice(requestBody.tool_choice),
          },
        }
      : {}),
    generationConfig: {
      temperature:
        typeof requestBody.temperature === 'number'
          ? requestBody.temperature
          : 1,
      maxOutputTokens:
        typeof requestBody.max_tokens === 'number'
          ? requestBody.max_tokens
          : 8192,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(geminiBody),
    },
  )

  const text = await response.text()
  const body = safeJsonParse(text, null)

  if (!response.ok) {
    const message =
      body?.error?.message || `Gemini request failed with status ${response.status}`
    const error = new Error(message)
    error.statusCode = response.status
    throw error
  }

  return body
}

function estimateCountTokens(body) {
  const text =
    normalizeSystemText(body.system) +
    '\n' +
    flattenText(body.messages) +
    '\n' +
    flattenText(body.tools)
  return Math.max(1, Math.ceil(text.length / 4))
}

export async function startGeminiAnthropicProxy({ apiKey }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = [
          'claude-haiku-4-5',
          'claude-sonnet-4-6',
          'claude-opus-4-1',
        ]
        sendJson(res, 200, {
          data: models.map(id => ({
            id,
            type: 'model',
            display_name: `DayCode Gemini Proxy (${id})`,
            created_at: '2026-04-05T00:00:00Z',
          })),
          has_more: false,
          first_id: models[0],
          last_id: models.at(-1),
        })
        return
      }

      if (req.method !== 'POST') {
        sendAnthropicError(res, 404, 'not_found_error', 'Not found')
        return
      }

      const rawBody = await readRequestBody(req)
      const body = safeJsonParse(rawBody, {})

      if (url.pathname === '/v1/messages/count_tokens') {
        sendJson(res, 200, {
          input_tokens: estimateCountTokens(body),
        })
        return
      }

      if (url.pathname !== '/v1/messages') {
        sendAnthropicError(res, 404, 'not_found_error', 'Not found')
        return
      }

      const geminiResponse = await callGemini(apiKey, body)
      const anthropicMessage = buildAnthropicMessage(body.model, geminiResponse)
      const requestId = `daycode_${randomUUID().replaceAll('-', '')}`

      if (body.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-request-id': requestId,
        })
        streamAnthropicMessage(res, anthropicMessage)
        return
      }

      sendJson(res, 200, anthropicMessage, {
        'x-request-id': requestId,
      })
    } catch (error) {
      const classified = classifyGeminiError(error)
      sendAnthropicError(
        res,
        classified.status,
        classified.type,
        classified.message,
        classified.headers,
      )
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const close = () =>
    new Promise(resolve => {
      server.close(() => resolve())
    })

  for (const signal of ['SIGINT', 'SIGTERM', 'exit']) {
    process.once(signal, () => {
      void close()
    })
  }

  return { port, close }
}
