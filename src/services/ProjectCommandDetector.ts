import fs from 'node:fs'
import path from 'node:path'

export type CommandKind = 'install' | 'build' | 'dev' | 'test' | 'lint' | 'typecheck'
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export type Ecosystem = 'node' | 'unknown'

export interface ProjectCommand {
  kind: CommandKind
  label: string
  command: string
  args: string[]
  display: string
  script?: string
  source: string
  confidence: number
  watch?: boolean
}

export interface DetectedEcosystem {
  ecosystem: Ecosystem
  packageManager?: PackageManager
  confidence: number
  sourceFiles: string[]
  commands: Partial<Record<CommandKind | 'testRun', ProjectCommand>>
  raw?: Record<string, unknown>
}

export interface ProjectCommandProfile {
  projectPath: string
  ecosystems: DetectedEcosystem[]
  primary?: DetectedEcosystem
}

type PackageJson = {
  packageManager?: string
  scripts?: Record<string, string>
}

const NON_WATCH_TEST_SCRIPTS = ['test:run', 'test:ci', 'test:unit', 'test:once']

export class ProjectCommandDetector {
  detect(projectPath: string): ProjectCommandProfile {
    const node = this.detectNode(projectPath)
    const ecosystems = node ? [node] : [{ ecosystem: 'unknown' as const, confidence: 0, sourceFiles: [], commands: {} }]

    return {
      projectPath,
      ecosystems,
      primary: ecosystems[0],
    }
  }

  getQualityCommands(projectPath: string): ProjectCommand[] {
    const profile = this.detect(projectPath)
    const commands = profile.primary?.commands || {}
    const testCommand = commands.testRun || commands.test

    return [
      commands.lint,
      testCommand,
      commands.build,
    ].filter((cmd): cmd is ProjectCommand => Boolean(cmd))
  }

  formatProfile(profile: ProjectCommandProfile): string {
    const primary = profile.primary
    if (!primary || primary.ecosystem === 'unknown') {
      return 'No project commands detected.'
    }

    const lines = [`${primary.ecosystem} project (${primary.packageManager || 'unknown'})`]
    for (const [kind, command] of Object.entries(primary.commands)) {
      if (command) lines.push(`- ${kind}: ${command.display}`)
    }
    return lines.join('\n')
  }

  private detectNode(projectPath: string): DetectedEcosystem | null {
    const packagePath = path.join(projectPath, 'package.json')
    if (!fs.existsSync(packagePath)) return null

    const pkg = this.readPackageJson(packagePath)
    if (!pkg) return null

    const packageManager = this.detectPackageManager(projectPath, pkg)
    const sourceFiles = ['package.json']
    for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json']) {
      if (fs.existsSync(path.join(projectPath, lockfile))) sourceFiles.push(lockfile)
    }

    const scripts = pkg.scripts || {}
    const commands: DetectedEcosystem['commands'] = {}

    if (scripts.build) commands.build = this.scriptCommand(packageManager, 'build', 'build', scripts.build)
    if (scripts.dev) commands.dev = this.scriptCommand(packageManager, 'dev', 'dev', scripts.dev, { watch: true })
    if (scripts.lint) commands.lint = this.scriptCommand(packageManager, 'lint', 'lint', scripts.lint)

    const typecheckScript = this.findTypecheckScript(scripts)
    if (typecheckScript) {
      commands.typecheck = this.scriptCommand(packageManager, 'typecheck', typecheckScript, scripts[typecheckScript])
    } else if (scripts.lint && /\btsc\b.*--noEmit|--noEmit.*\btsc\b/.test(scripts.lint)) {
      commands.typecheck = this.scriptCommand(packageManager, 'typecheck', 'lint', scripts.lint)
    }

    const testRunScript = NON_WATCH_TEST_SCRIPTS.find((script) => scripts[script]) || this.findNonWatchTestScript(scripts)
    if (testRunScript) {
      commands.testRun = this.scriptCommand(packageManager, 'test', testRunScript, scripts[testRunScript])
    }
    if (scripts.test) {
      commands.test = this.scriptCommand(packageManager, 'test', 'test', scripts.test, { watch: !this.isNonWatchTestScript(scripts.test) })
    }

    return {
      ecosystem: 'node',
      packageManager,
      confidence: 0.95,
      sourceFiles,
      commands,
      raw: { scripts },
    }
  }

  private readPackageJson(packagePath: string): PackageJson | null {
    try {
      return JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as PackageJson
    } catch {
      return null
    }
  }

  private detectPackageManager(projectPath: string, pkg: PackageJson): PackageManager {
    const packageManager = pkg.packageManager?.split('@')[0]
    if (packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn' || packageManager === 'bun') {
      return packageManager
    }
    if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm'
    if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn'
    if (fs.existsSync(path.join(projectPath, 'bun.lock')) || fs.existsSync(path.join(projectPath, 'bun.lockb'))) return 'bun'
    return 'npm'
  }

  private scriptCommand(pm: PackageManager, kind: CommandKind, script: string, body: string, options: { watch?: boolean } = {}): ProjectCommand {
    const args = pm === 'npm' ? ['run', script] : pm === 'pnpm' ? ['run', script] : pm === 'yarn' ? [script] : ['run', script]
    const command = pm
    const display = `${command} ${args.join(' ')}`
    return {
      kind,
      label: script,
      command,
      args,
      display,
      script,
      source: `package.json:scripts.${script}`,
      confidence: this.commandConfidence(script, body),
      watch: options.watch,
    }
  }

  private findTypecheckScript(scripts: Record<string, string>): string | null {
    return Object.keys(scripts).find((script) => /type-?check/i.test(script)) || null
  }

  private findNonWatchTestScript(scripts: Record<string, string>): string | null {
    return Object.entries(scripts).find(([script, body]) => script.startsWith('test:') && this.isNonWatchTestScript(body))?.[0] || null
  }

  private isNonWatchTestScript(body: string): boolean {
    return /\b(run|ci|--run|--watch=false|--runInBand)\b/i.test(body)
  }

  private commandConfidence(script: string, body: string): number {
    if (script === 'test' && !this.isNonWatchTestScript(body)) return 0.75
    if (/\btsc\b.*--noEmit|--noEmit.*\btsc\b/.test(body)) return 0.9
    return 0.95
  }
}

export const projectCommandDetector = new ProjectCommandDetector()
