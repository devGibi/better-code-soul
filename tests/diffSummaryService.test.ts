import { describe, expect, it } from 'vitest'
import { DiffSummaryService } from '../src/services/DiffSummaryService'
import type { AgentResult } from '../src/subagents/AgentRunner'

describe('DiffSummaryService', () => {
  const makeResult = (agentId: string, output: string): AgentResult => ({
    agentId,
    output,
    inputTokens: 10,
    outputTokens: 10,
    model: 'test-model',
    durationMs: 100,
    success: true,
  })

  it('summarizes files, hunks, additions and deletions', () => {
    const summary = new DiffSummaryService().summarizeAgentDiffs([
      makeResult('coder_A', [
        'diff --git a/src/a.ts b/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,3 @@',
        '-old',
        '+new',
        '+extra',
      ].join('\n')),
    ])

    expect(summary.filesTouched).toBe(1)
    expect(summary.totalHunks).toBe(1)
    expect(summary.totalAdditions).toBe(2)
    expect(summary.totalDeletions).toBe(1)
    expect(summary.files[0].agents).toEqual(['coder_A'])
  })

  it('includes overlapping diff conflicts', () => {
    const summary = new DiffSummaryService().summarizeAgentDiffs([
      makeResult('coder_A', 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,5 @@\n+x'),
      makeResult('coder_B', 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -12,2 +12,4 @@\n+y'),
    ])

    expect(summary.conflictCount).toBe(1)
    expect(summary.conflicts[0].reason).toBe('overlapping diff hunks')
  })
})
