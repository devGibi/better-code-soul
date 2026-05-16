import fs from 'node:fs'
import path from 'node:path'
import { runCommand } from '../utils/spawn.js'
import { paths } from '../utils/platform.js'

export interface CheckpointResult {
  id: string
  strategy: 'git-diff' | 'none'
  label: string
  projectPath: string
  patchPath?: string
  status: string
  safeToRollback: boolean
  createdAt: number
  error?: string
}

export class CheckpointService {
  async create(projectPath: string, label: string): Promise<CheckpointResult> {
    const createdAt = Date.now()
    const id = `bcs_${createdAt}`

    try {
      const inside = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath, timeout: 30_000 })
      if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
        return { id, strategy: 'none', label, projectPath, status: '', safeToRollback: false, createdAt, error: 'Not a git worktree' }
      }

      const status = await runCommand('git', ['status', '--porcelain'], { cwd: projectPath, timeout: 30_000 })
      const diff = await runCommand('git', ['diff', '--binary'], { cwd: projectPath, timeout: 60_000 })
      const checkpointDir = path.join(paths.hubData(), 'checkpoints')
      await fs.promises.mkdir(checkpointDir, { recursive: true })
      const patchPath = path.join(checkpointDir, `${id}.patch`)
      await fs.promises.writeFile(patchPath, diff.stdout, 'utf-8')

      return {
        id,
        strategy: 'git-diff',
        label,
        projectPath,
        patchPath,
        status: status.stdout.trim(),
        safeToRollback: status.stdout.trim().length === 0,
        createdAt,
      }
    } catch (err) {
      return { id, strategy: 'none', label, projectPath, status: '', safeToRollback: false, createdAt, error: String(err) }
    }
  }

  async rollback(checkpoint: CheckpointResult): Promise<{ success: boolean; message: string }> {
    if (!checkpoint.safeToRollback || !checkpoint.patchPath) {
      return { success: false, message: 'Checkpoint is not safe to rollback automatically.' }
    }
    if (!fs.existsSync(checkpoint.patchPath)) {
      return { success: false, message: 'Checkpoint patch file is missing.' }
    }

    const result = await runCommand('git', ['apply', '-R', checkpoint.patchPath], { cwd: checkpoint.projectPath, timeout: 120_000 })
    return {
      success: result.exitCode === 0,
      message: result.exitCode === 0 ? 'Rollback applied.' : (result.stderr || result.stdout || 'Rollback failed.'),
    }
  }
}

export const checkpointService = new CheckpointService()
