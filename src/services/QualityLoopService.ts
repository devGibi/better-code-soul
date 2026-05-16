import type { AgentResult } from '../subagents/AgentRunner.js'
import type { MergedResult } from '../subagents/ResultMerger.js'
import { runCommand } from '../utils/spawn.js'
import { formatCost, formatDuration } from '../utils/format.js'
import { projectCommandDetector, type ProjectCommand, type ProjectCommandProfile } from './ProjectCommandDetector.js'
import { diffSummaryService, type DiffSummary } from './DiffSummaryService.js'
import type { CheckpointResult } from './CheckpointService.js'

export interface QualityCommandResult {
  kind: string
  label: string
  display: string
  command: string
  args: string[]
  exitCode: number
  durationMs: number
  success: boolean
  stdout: string
  stderr: string
}

export interface QualityLoopResult {
  projectPath: string
  profile: ProjectCommandProfile
  commands: QualityCommandResult[]
  score: number
  passed: boolean
  successfulTasks: number
  failedTasks: number
  costPerSuccessfulTask: number
  retryCount: number
  shouldRetry: boolean
  rollbackRecommended: boolean
  checkpoint?: CheckpointResult
  diffSummary: DiffSummary
  summary: string
}

export interface QualityLoopInput {
  projectPath: string
  merged: MergedResult
  allResults: AgentResult[]
  totalCost: number
  retryCount?: number
  checkpoint?: CheckpointResult
  commandTimeoutMs?: number
}

export class QualityLoopService {
  async run(input: QualityLoopInput): Promise<QualityLoopResult> {
    const profile = projectCommandDetector.detect(input.projectPath)
    const detectedCommands = projectCommandDetector.getQualityCommands(input.projectPath)
    const commands: QualityCommandResult[] = []

    for (const command of detectedCommands) {
      commands.push(await this.runQualityCommand(input.projectPath, command, input.commandTimeoutMs || 180_000))
    }

    const diffSummary = input.merged.diffSummary || diffSummaryService.summarizeAgentDiffs(input.allResults.filter((r) => r.agentId.startsWith('coder')))
    const successfulTasks = input.allResults.filter((result) => result.success).length
    const failedTasks = Math.max(input.allResults.length - successfulTasks, 0)
    const score = this.score({ commands, allResults: input.allResults, merged: input.merged, retryCount: input.retryCount || 0, diffSummary })
    const failedCommands = commands.filter((command) => !command.success)
    const passed = score >= 80 && failedCommands.length === 0
    const costPerSuccessfulTask = successfulTasks > 0 ? input.totalCost / successfulTasks : input.totalCost
    const shouldRetry = !passed && (input.retryCount || 0) < 1 && (failedCommands.length > 0 || failedTasks > 0)
    const rollbackRecommended = !passed && !shouldRetry && Boolean(input.checkpoint?.safeToRollback)

    return {
      projectPath: input.projectPath,
      profile,
      commands,
      score,
      passed,
      successfulTasks,
      failedTasks,
      costPerSuccessfulTask,
      retryCount: input.retryCount || 0,
      shouldRetry,
      rollbackRecommended,
      checkpoint: input.checkpoint,
      diffSummary,
      summary: this.formatSummary({ commands, score, passed, costPerSuccessfulTask, retryCount: input.retryCount || 0, rollbackRecommended, diffSummary }),
    }
  }

  formatSummary(result: Pick<QualityLoopResult, 'commands' | 'score' | 'passed' | 'costPerSuccessfulTask' | 'retryCount' | 'rollbackRecommended' | 'diffSummary'>): string {
    const lines = [
      `Quality score: ${result.score}/100 (${result.passed ? 'PASS' : 'FAIL'})`,
      `Cost per successful task: ${formatCost(result.costPerSuccessfulTask)}`,
      `Retries: ${result.retryCount}`,
    ]

    if (result.commands.length > 0) {
      lines.push('Commands:')
      for (const command of result.commands) {
        lines.push(`- ${command.display}: ${command.success ? 'PASS' : `FAIL (${command.exitCode})`} · ${formatDuration(command.durationMs)}`)
      }
    } else {
      lines.push('Commands: none detected')
    }

    lines.push('Diff: ' + diffSummaryService.format(result.diffSummary))
    if (result.rollbackRecommended) lines.push('Rollback: safe checkpoint available; manual rollback recommended.')
    return lines.join('\n')
  }

  private async runQualityCommand(projectPath: string, command: ProjectCommand, timeoutMs: number): Promise<QualityCommandResult> {
    const start = Date.now()
    try {
      const result = await runCommand(command.command, command.args, { cwd: projectPath, timeout: timeoutMs })
      return {
        kind: command.kind,
        label: command.label,
        display: command.display,
        command: command.command,
        args: command.args,
        exitCode: result.exitCode,
        durationMs: Date.now() - start,
        success: result.exitCode === 0,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
      }
    } catch (err) {
      return {
        kind: command.kind,
        label: command.label,
        display: command.display,
        command: command.command,
        args: command.args,
        exitCode: 1,
        durationMs: Date.now() - start,
        success: false,
        stdout: '',
        stderr: tail(String(err)),
      }
    }
  }

  private score(input: { commands: QualityCommandResult[]; allResults: AgentResult[]; merged: MergedResult; retryCount: number; diffSummary: DiffSummary }): number {
    const commandRatio = input.commands.length > 0
      ? input.commands.filter((command) => command.success).length / input.commands.length
      : 1
    const agentRatio = input.allResults.length > 0
      ? input.allResults.filter((result) => result.success).length / input.allResults.length
      : 1
    const reviewIssuePenalty = Math.min(input.merged.issues.length * 0.25, 0.75)
    const conflictPenalty = Math.min(input.diffSummary.conflictCount * 0.35, 0.7)
    const reviewConflictRatio = Math.max(0, 1 - reviewIssuePenalty - conflictPenalty)
    const retryRatio = Math.max(0.4, 1 - input.retryCount * 0.25)

    return Math.round(100 * (
      0.45 * commandRatio +
      0.35 * agentRatio +
      0.15 * reviewConflictRatio +
      0.05 * retryRatio
    ))
  }
}

function tail(value: string, max = 2000): string {
  const compact = value.replace(/\r/g, '').trim()
  return compact.length > max ? compact.slice(-max) : compact
}

export const qualityLoopService = new QualityLoopService()
