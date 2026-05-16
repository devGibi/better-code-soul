import { describe, it, expect } from 'vitest'
import { ResultMerger } from '../src/subagents/ResultMerger'
import type { AgentResult } from '../src/subagents/AgentRunner'

describe('ResultMerger', () => {
  const merger = new ResultMerger()

  const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
    agentId: 'test_1',
    output: 'Test output',
    inputTokens: 100,
    outputTokens: 50,
    model: 'test-model',
    durationMs: 1000,
    success: true,
    ...overrides,
  })

  it('merges successful results', async () => {
    const planResult = makeResult({ agentId: 'planner_1', output: 'Plan output' })
    const coderResults = [
      makeResult({ agentId: 'coder_A', output: 'Code A output' }),
      makeResult({ agentId: 'coder_B', output: 'Code B output' }),
    ]
    const reviewResults = [
      makeResult({ agentId: 'reviewer_1', output: 'ONAYLANDI' }),
    ]

    const merged = await merger.merge({ planResult, coderResults, reviewResults })

    expect(merged.output).toContain('Plan output')
    expect(merged.output).toContain('Code A output')
    expect(merged.output).toContain('Code B output')
    expect(merged.output).toContain('Tum Parcalar Onaylandi')
    expect(merged.agentCount).toBe(4)
    expect(merged.totalTokens).toBeGreaterThan(0)
    expect(merged.hasConflicts).toBe(false)
    expect(merged.issues.length).toBe(0)
  })

  it('detects review issues', async () => {
    const planResult = makeResult({ agentId: 'planner_1' })
    const coderResults = [makeResult({ agentId: 'coder_A' })]
    const reviewResults = [
      makeResult({ agentId: 'reviewer_1', output: 'Tip hatası var: src/foo.ts:42' }),
    ]

    const merged = await merger.merge({ planResult, coderResults, reviewResults })

    expect(merged.issues.length).toBe(1)
    expect(merged.output).toContain('Review Bulgulari')
  })

  it('detects file conflicts', async () => {
    const planResult = makeResult({ agentId: 'planner_1' })
    const coderResults = [
      makeResult({ agentId: 'coder_A', output: 'diff --git a/src/components/Button.tsx b/src/components/Button.tsx\n+++ b/src/components/Button.tsx\n@@ -10,3 +10,5 @@\n+const x = 1' }),
      makeResult({ agentId: 'coder_B', output: 'diff --git a/src/components/Button.tsx b/src/components/Button.tsx\n+++ b/src/components/Button.tsx\n@@ -12,2 +12,4 @@\n+const y = 2' }),
    ]
    const reviewResults: AgentResult[] = []

    const merged = await merger.merge({ planResult, coderResults, reviewResults })

    expect(merged.hasConflicts).toBe(true)
    expect(merged.output).toContain('Dosya Cakismalari')
    expect(merged.output).toContain('overlapping diff hunks')
  })
})
