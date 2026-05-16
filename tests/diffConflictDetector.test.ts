import { describe, expect, it } from 'vitest'
import { detectDiffConflicts, parseDiffHunks } from '../src/subagents/DiffConflictDetector'
import type { AgentResult } from '../src/subagents/AgentRunner'

const makeResult = (agentId: string, output: string): AgentResult => ({
  agentId,
  output,
  inputTokens: 0,
  outputTokens: 0,
  model: 'test',
  durationMs: 0,
  success: true,
})

describe('DiffConflictDetector', () => {
  it('parses unified diff hunks', () => {
    const hunks = parseDiffHunks('diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +5,4 @@\n+hello', 'coder_A')
    expect(hunks).toEqual([{ file: 'src/a.ts', agentId: 'coder_A', start: 5, end: 8, header: '@@ -3,2 +5,4 @@' }])
  })

  it('detects overlapping hunks in the same file', () => {
    const results = [
      makeResult('coder_A', 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +10,5 @@'),
      makeResult('coder_B', 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -8,2 +12,3 @@'),
    ]
    expect(detectDiffConflicts(results)).toHaveLength(1)
  })

  it('does not flag separate hunks', () => {
    const results = [
      makeResult('coder_A', 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +10,2 @@'),
      makeResult('coder_B', 'diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -40,2 +40,3 @@'),
    ]
    expect(detectDiffConflicts(results)).toHaveLength(0)
  })
})
