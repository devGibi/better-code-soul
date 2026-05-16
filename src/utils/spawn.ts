import { spawn as cpSpawn, type SpawnOptions } from 'node:child_process'
import path from 'node:path'

export interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SpawnStreamResult extends SpawnResult {
  lines: string[]
}

export function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(command)
    const proc = cpSpawn(resolved.command, args, {
      ...options,
      shell: options.shell ?? resolved.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', reject)
    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      })
    })
  })
}

export async function* streamCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): AsyncGenerator<string> {
  const resolved = resolveCommand(command)
  const proc = cpSpawn(resolved.command, args, {
    ...options,
    shell: options.shell ?? resolved.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let buffer = ''
  const lines: string[] = []

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const parts = buffer.split('\n')
    buffer = parts.pop()!
    for (const part of parts) {
      lines.push(part)
    }
  })

  await new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', () => {
      if (buffer.length > 0) {
        lines.push(buffer)
      }
      resolve()
    })
  })

  for (const line of lines) {
    yield line
  }
}

export function commandExists(command: string): Promise<boolean> {
  const checkCmd = process.platform === 'win32' ? 'where' : 'which'
  return runCommand(checkCmd, [command])
    .then((r) => r.exitCode === 0)
    .catch(() => false)
}

const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'opencode', 'context-mode'])

function resolveCommand(command: string): { command: string; shell: boolean } {
  if (process.platform !== 'win32') return { command, shell: false }
  if (!WINDOWS_CMD_SHIMS.has(command)) return { command, shell: false }
  if (path.extname(command)) return { command, shell: true }
  return { command: `${command}.cmd`, shell: true }
}
