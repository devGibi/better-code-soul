import type { AgentResult } from './AgentRunner.js'

export interface DiffRange {
  start: number | null
  end: number | null
  header?: string
}

export interface ParsedDiffHunk extends DiffRange {
  file: string
  agentId: string
}

export interface FileConflict {
  file: string
  agents: string[]
  ranges: DiffRange[]
  reason: string
}

const FILE_HINT_RE = /(?:^|\s)((?:src|tests|__tests__|migrations|prisma)\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9]+)/gm

export function parseDiffHunks(output: string, agentId: string): ParsedDiffHunk[] {
  const hunks: ParsedDiffHunk[] = []
  const lines = output.split(/\r?\n/)
  let currentFile: string | null = null

  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (diffMatch) {
      currentFile = normalizePath(diffMatch[2])
      continue
    }

    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/)
    if (plusMatch) {
      currentFile = normalizePath(plusMatch[1])
      continue
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunkMatch && currentFile) {
      const start = Number(hunkMatch[1])
      const length = hunkMatch[2] ? Number(hunkMatch[2]) : 1
      hunks.push({
        file: currentFile,
        agentId,
        start,
        end: start + Math.max(length, 1) - 1,
        header: hunkMatch[0],
      })
    }
  }

  if (hunks.length > 0) return hunks

  return parseFileHints(output, agentId)
}

export function detectDiffConflicts(results: AgentResult[]): FileConflict[] {
  const hunks = results.flatMap((result) => parseDiffHunks(result.output, result.agentId))
  const byFile = new Map<string, ParsedDiffHunk[]>()

  for (const hunk of hunks) {
    if (!byFile.has(hunk.file)) byFile.set(hunk.file, [])
    byFile.get(hunk.file)!.push(hunk)
  }

  const conflicts: FileConflict[] = []
  for (const [file, fileHunks] of byFile.entries()) {
    const conflictRanges: DiffRange[] = []
    const agents = new Set<string>()

    for (let i = 0; i < fileHunks.length; i++) {
      for (let j = i + 1; j < fileHunks.length; j++) {
        const left = fileHunks[i]
        const right = fileHunks[j]
        if (left.agentId === right.agentId) continue
        if (!rangesOverlap(left, right)) continue
        agents.add(left.agentId)
        agents.add(right.agentId)
        conflictRanges.push(left, right)
      }
    }

    if (agents.size > 0) {
      conflicts.push({
        file,
        agents: [...agents].sort(),
        ranges: dedupeRanges(conflictRanges),
        reason: conflictRanges.some((range) => range.start === null) ? 'same file touched without diff hunks' : 'overlapping diff hunks',
      })
    }
  }

  return conflicts
}

function parseFileHints(output: string, agentId: string): ParsedDiffHunk[] {
  const seen = new Set<string>()
  const hunks: ParsedDiffHunk[] = []
  for (const match of output.matchAll(FILE_HINT_RE)) {
    const file = normalizePath(match[1])
    if (seen.has(file)) continue
    seen.add(file)
    hunks.push({ file, agentId, start: null, end: null })
  }
  return hunks
}

function rangesOverlap(left: DiffRange, right: DiffRange): boolean {
  if (left.start === null || left.end === null || right.start === null || right.end === null) return true
  return left.start <= right.end && right.start <= left.end
}

function dedupeRanges(ranges: DiffRange[]): DiffRange[] {
  const seen = new Set<string>()
  const result: DiffRange[] = []
  for (const range of ranges) {
    const key = `${range.start}:${range.end}:${range.header || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ start: range.start, end: range.end, header: range.header })
  }
  return result
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '')
}
