import type { AgentResult } from '../subagents/AgentRunner.js'
import { detectDiffConflicts, type FileConflict } from '../subagents/DiffConflictDetector.js'

export interface DiffFileSummary {
  file: string
  additions: number
  deletions: number
  hunks: number
  agents: string[]
}

export interface DiffSummary {
  filesTouched: number
  totalAdditions: number
  totalDeletions: number
  totalHunks: number
  files: DiffFileSummary[]
  conflictCount: number
  conflicts: FileConflict[]
}

export class DiffSummaryService {
  summarizeAgentDiffs(results: AgentResult[]): DiffSummary {
    const files = new Map<string, DiffFileSummary>()

    for (const result of results) {
      this.collect(result, files)
    }

    const conflicts = detectDiffConflicts(results)
    const fileList = [...files.values()].sort((a, b) => a.file.localeCompare(b.file))

    return {
      filesTouched: fileList.length,
      totalAdditions: fileList.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: fileList.reduce((sum, file) => sum + file.deletions, 0),
      totalHunks: fileList.reduce((sum, file) => sum + file.hunks, 0),
      files: fileList,
      conflictCount: conflicts.length,
      conflicts,
    }
  }

  format(summary: DiffSummary): string {
    if (summary.filesTouched === 0) return 'No unified diff output detected.'

    const lines = [
      `Files: ${summary.filesTouched} · Hunks: ${summary.totalHunks} · +${summary.totalAdditions} / -${summary.totalDeletions}`,
    ]
    for (const file of summary.files.slice(0, 10)) {
      lines.push(`- ${file.file}: ${file.hunks} hunk(s), +${file.additions}/-${file.deletions} (${file.agents.join(', ')})`)
    }
    if (summary.files.length > 10) lines.push(`- ... ${summary.files.length - 10} more file(s)`)
    if (summary.conflictCount > 0) lines.push(`Conflicts: ${summary.conflictCount}`)
    return lines.join('\n')
  }

  private collect(result: AgentResult, files: Map<string, DiffFileSummary>): void {
    let currentFile: string | null = null
    const lines = result.output.split(/\r?\n/)

    for (const line of lines) {
      const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      if (diffMatch) {
        currentFile = normalizePath(diffMatch[2])
        ensureFile(files, currentFile, result.agentId)
        continue
      }

      const fileMatch = line.match(/^\+\+\+ b\/(.+)$/)
      if (fileMatch) {
        currentFile = normalizePath(fileMatch[1])
        ensureFile(files, currentFile, result.agentId)
        continue
      }

      if (!currentFile) continue
      const file = ensureFile(files, currentFile, result.agentId)

      if (line.startsWith('@@')) {
        file.hunks += 1
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        file.additions += 1
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        file.deletions += 1
      }
    }
  }
}

function ensureFile(files: Map<string, DiffFileSummary>, file: string, agentId: string): DiffFileSummary {
  let existing = files.get(file)
  if (!existing) {
    existing = { file, additions: 0, deletions: 0, hunks: 0, agents: [] }
    files.set(file, existing)
  }
  if (!existing.agents.includes(agentId)) existing.agents.push(agentId)
  return existing
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').trim()
}

export const diffSummaryService = new DiffSummaryService()
