import { db } from './Database.js'
import { costCalculator, type TokenUsage } from './CostCalculator.js'
import { modelRegistry } from './ModelRegistry.js'
import { logger } from '../utils/logger.js'

interface ToolStartInfo {
  tool: string
  input: unknown
  startTime: number
}

export class TokenTracker {
  private activeTools = new Map<string, ToolStartInfo>()
  private sessionId: string

  constructor() {
    this.sessionId = `session_${Date.now()}`
  }

  init(): void {
    logger.info('TokenTracker initialized', { sessionId: this.sessionId })
  }

  recordToolStart(tool: string, input: unknown): void {
    const key = `${tool}_${Date.now()}`
    this.activeTools.set(key, { tool, input, startTime: Date.now() })
    logger.debug(`Tool started: ${tool}`, { key })
  }

  recordToolEnd(tool: string, tokens: TokenUsage, output: unknown): void {
    const fallbackModel = modelRegistry.getBestFor('code')
    const model = tokens.model ? modelRegistry.getById(tokens.model) || fallbackModel : fallbackModel
    const cost = costCalculator.calculate(tokens, model)
    const started = this.takeLatestStart(tool)

    db.saveToolCall({
      sessionId: this.sessionId,
      tool,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cost,
      model: tokens.model || model.id,
      timestamp: Date.now(),
      durationMs: started ? Date.now() - started.startTime : 0,
    })

    logger.debug(`Tool ended: ${tool}`, { tokens, cost, source: tokens.source, confidence: tokens.confidence })
  }

  private takeLatestStart(tool: string): ToolStartInfo | null {
    let latestKey: string | null = null
    let latest: ToolStartInfo | null = null

    for (const [key, value] of this.activeTools.entries()) {
      if (value.tool !== tool) continue
      if (!latest || value.startTime > latest.startTime) {
        latestKey = key
        latest = value
      }
    }

    if (latestKey) {
      this.activeTools.delete(latestKey)
    }
    return latest
  }

  getSessionId(): string {
    return this.sessionId
  }

  getSessionStats(): {
    totalInput: number
    totalOutput: number
    totalCost: number
    toolCount: number
  } {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    return db.getTokenStatsByPeriod(startOfDay.getTime())
  }

  getTodayCost(): number {
    return db.getTodayCost()
  }
}

export function parseTokensFromOutput(output: unknown): TokenUsage {
  const structured = parseStructuredTokenUsage(output)
  if (structured) return structured

  const text = typeof output === 'string' ? output : JSON.stringify(output || '')

  const tokenMatch = text.match(/tokens?:\s*([\d,]+)/i)
  const inputMatch = text.match(/(?:input|prompt).*?([\d,]+).*?token/i)
  const outputMatch = text.match(/(?:output|completion|candidate).*?([\d,]+).*?token/i)
  const costMatch = text.match(/cost:\s*\$?([\d.]+)/i)
  const modelMatch = text.match(/model:\s*([a-z0-9._-]+)/i)

  let inputTokens = 0
  let outputTokens = 0

  if (inputMatch) {
    inputTokens = toInt(inputMatch[1])
  } else if (tokenMatch) {
    const total = toInt(tokenMatch[1])
    inputTokens = Math.ceil(total * 0.3)
    outputTokens = Math.max(total - inputTokens, 0)
  }

  if (outputMatch) {
    outputTokens = toInt(outputMatch[1])
  }

  if (inputTokens === 0 && outputTokens === 0) {
    const estimated = estimateTokens(text)
    inputTokens = estimated.input
    outputTokens = estimated.output
  }

  return {
    input: inputTokens,
    output: outputTokens,
    total: inputTokens + outputTokens,
    model: modelMatch?.[1],
    source: inputMatch || outputMatch || tokenMatch || costMatch ? 'regex' : 'estimate',
    confidence: inputMatch || outputMatch ? 'medium' : 'low',
  }
}

function parseStructuredTokenUsage(output: unknown): TokenUsage | null {
  const value = normalizeStructuredOutput(output)
  if (!value || typeof value !== 'object') return null
  return findUsage(value, value)
}

function normalizeStructuredOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output

  const text = output.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function findUsage(value: unknown, root: unknown, depth = 0): TokenUsage | null {
  if (!value || typeof value !== 'object' || depth > 5) return null
  const obj = value as Record<string, unknown>

  if (obj.usageMetadata && typeof obj.usageMetadata === 'object') {
    return parseUsageObject(obj.usageMetadata as Record<string, unknown>, root, 'provider', {
      input: ['promptTokenCount'],
      output: ['candidatesTokenCount'],
      total: ['totalTokenCount'],
      model: ['modelVersion'],
    })
  }

  if (obj.usage && typeof obj.usage === 'object') {
    return parseUsageObject(obj.usage as Record<string, unknown>, root, detectUsageSource(obj.usage as Record<string, unknown>))
  }

  const direct = parseUsageObject(obj, root, detectUsageSource(obj))
  if (direct) return direct

  for (const child of Object.values(obj)) {
    const nested = findUsage(child, root, depth + 1)
    if (nested) return nested
  }

  return null
}

function parseUsageObject(
  usage: Record<string, unknown>,
  root: unknown,
  source: TokenUsage['source'] = 'provider',
  aliases?: { input: string[]; output: string[]; total: string[]; model?: string[] }
): TokenUsage | null {
  const input = firstNumber(usage, aliases?.input || ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'prompt', 'input'])
  const output = firstNumber(usage, aliases?.output || ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'candidate_tokens', 'candidateTokens', 'completion', 'output'])
  const total = firstNumber(usage, aliases?.total || ['total_tokens', 'totalTokens', 'totalTokenCount', 'tokens', 'total'])

  if (input === null && output === null && total === null) return null

  const normalizedInput = input ?? (total !== null && output !== null ? Math.max(total - output, 0) : 0)
  const normalizedOutput = output ?? (total !== null ? Math.max(total - normalizedInput, 0) : 0)

  return {
    input: normalizedInput,
    output: normalizedOutput,
    total: total ?? normalizedInput + normalizedOutput,
    model: findModel(root, aliases?.model),
    source,
    confidence: input !== null && output !== null ? 'high' : 'medium',
  }
}

function detectUsageSource(usage: Record<string, unknown>): TokenUsage['source'] {
  if ('input_tokens' in usage || 'output_tokens' in usage) return 'provider'
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) return 'provider'
  if ('input_tokens' in usage || 'output_tokens' in usage || 'inputTokens' in usage || 'outputTokens' in usage) return 'opencode'
  return 'provider'
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
    if (typeof value === 'string' && /^\d[\d,]*$/.test(value.trim())) return toInt(value)
  }
  return null
}

function findModel(root: unknown, preferredKeys: string[] = []): string | undefined {
  const keys = [...preferredKeys, 'model', 'modelId', 'model_id', 'modelVersion']
  const found = findStringKey(root, keys)
  return found && /^[a-z0-9._:-]+$/i.test(found) ? found : undefined
}

function findStringKey(value: unknown, keys: string[], depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 4) return undefined
  const obj = value as Record<string, unknown>
  for (const key of keys) {
    if (typeof obj[key] === 'string') return obj[key] as string
  }
  for (const child of Object.values(obj)) {
    const found = findStringKey(child, keys, depth + 1)
    if (found) return found
  }
  return undefined
}

function toInt(value: string): number {
  return parseInt(value.replace(/,/g, ''), 10)
}

function estimateTokens(text: string): { input: number; output: number } {
  const charCount = text.length
  const estimatedTokens = Math.ceil(charCount / 4)

  return {
    input: Math.ceil(estimatedTokens * 0.3),
    output: Math.ceil(estimatedTokens * 0.7),
  }
}

export const tokenTracker = new TokenTracker()
