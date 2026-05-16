import { describe, it, expect } from 'vitest'
import { parseTokensFromOutput } from '../src/services/TokenTracker'

describe('parseTokensFromOutput', () => {
  it('parses token count from output', () => {
    const output = 'tokens: 1500'
    const result = parseTokensFromOutput(output)
    expect(result.input).toBeGreaterThan(0)
  })

  it('parses input/output tokens', () => {
    const output = 'input: 1000 tokens, output: 500 tokens'
    const result = parseTokensFromOutput(output)
    expect(result.input).toBe(1000)
    expect(result.output).toBe(500)
  })

  it('parses model from output', () => {
    const output = 'model: claude-sonnet-4-5 tokens: 100'
    const result = parseTokensFromOutput(output)
    expect(result.model).toBe('claude-sonnet-4-5')
  })

  it('estimates tokens when no pattern matches', () => {
    const output = 'A'.repeat(4000) // ~1000 tokens estimated
    const result = parseTokensFromOutput(output)
    expect(result.input).toBeGreaterThan(0)
    expect(result.output).toBeGreaterThan(0)
  })

  it('handles empty output', () => {
    const result = parseTokensFromOutput('')
    expect(result.input).toBeGreaterThanOrEqual(0)
    expect(result.output).toBeGreaterThanOrEqual(0)
  })

  it('handles object output', () => {
    const result = parseTokensFromOutput({ text: 'some output' })
    expect(result.input).toBeGreaterThanOrEqual(0)
  })

  it('parses OpenAI-style usage objects', () => {
    const result = parseTokensFromOutput({ model: 'gpt-4o', usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } })
    expect(result.input).toBe(1200)
    expect(result.output).toBe(300)
    expect(result.total).toBe(1500)
    expect(result.model).toBe('gpt-4o')
    expect(result.confidence).toBe('high')
  })

  it('parses Anthropic/OpenCode-style usage objects', () => {
    const result = parseTokensFromOutput(JSON.stringify({ model: 'claude-sonnet-4-5', usage: { input_tokens: 900, output_tokens: 100 } }))
    expect(result.input).toBe(900)
    expect(result.output).toBe(100)
    expect(result.model).toBe('claude-sonnet-4-5')
  })

  it('parses Gemini usage metadata', () => {
    const result = parseTokensFromOutput({ modelVersion: 'gemini-2.5-pro', usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 70, totalTokenCount: 770 } })
    expect(result.input).toBe(700)
    expect(result.output).toBe(70)
    expect(result.total).toBe(770)
    expect(result.model).toBe('gemini-2.5-pro')
  })
})
