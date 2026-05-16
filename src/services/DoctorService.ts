import fs from 'node:fs'
import path from 'node:path'
import { commandExists } from '../utils/spawn.js'
import { paths } from '../utils/platform.js'
import { authReader } from './AuthReader.js'
import { graphifyService } from './GraphifyService.js'
import { contextModeService } from './ContextModeService.js'
import { db } from './Database.js'

export type DoctorStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  area: string
  status: DoctorStatus
  message: string
  detail?: string
  remedy?: string
}

export interface DoctorReport {
  ok: boolean
  generatedAt: string
  projectPath: string
  checks: DoctorCheck[]
  summary: {
    pass: number
    warn: number
    fail: number
  }
}

const COMMAND_NAMES = [
  'bcs',
  'bcs-status',
  'bcs-tokens',
  'bcs-models',
  'bcs-graphify',
  'bcs-context-mode',
  'bcs-optimize',
  'bcs-agent',
  'bcs-doctor',
]

export class DoctorService {
  async run(projectPath = process.cwd()): Promise<DoctorReport> {
    const checks: DoctorCheck[] = []

    checks.push(this.checkNode())
    checks.push(this.checkPackageBuild(projectPath))
    checks.push(await this.checkOpencodeCommand())
    checks.push(this.checkDataDirectory())
    checks.push(this.checkGlobalConfig())
    checks.push(...await this.checkAuth())
    checks.push(...await this.checkGraphify(projectPath))
    checks.push(...await this.checkContextMode(projectPath))
    checks.push(this.checkTokenHistory())

    const summary = checks.reduce((acc, check) => {
      acc[check.status] += 1
      return acc
    }, { pass: 0, warn: 0, fail: 0 })

    return {
      ok: summary.fail === 0,
      generatedAt: new Date().toISOString(),
      projectPath,
      checks,
      summary,
    }
  }

  formatMarkdown(report: DoctorReport): string {
    const lines = [
      '## Better Code Soul Doctor',
      '',
      `Project: \`${report.projectPath}\``,
      `Result: ${report.ok ? 'READY' : 'NEEDS ATTENTION'} · ${report.summary.pass} pass / ${report.summary.warn} warn / ${report.summary.fail} fail`,
      '',
      '| Area | Status | Finding | Fix |',
      '|---|---|---|---|',
    ]

    for (const check of report.checks) {
      lines.push(`| ${check.area} | ${this.statusLabel(check.status)} | ${this.escapeTable(check.message + (check.detail ? ` (${check.detail})` : ''))} | ${this.escapeTable(check.remedy || '-')} |`)
    }

    const firstFix = report.checks.find((check) => check.status === 'fail' || check.status === 'warn')
    lines.push('')
    lines.push(firstFix ? `Next step: ${firstFix.remedy || firstFix.message}` : 'Next step: `/bcs` ile dashboardu ac ve `/bcs-optimize` onerilerine bak.')
    return lines.join('\n')
  }

  private checkNode(): DoctorCheck {
    const major = Number(process.versions.node.split('.')[0])
    if (major >= 18) {
      return { area: 'Node.js', status: 'pass', message: `Node ${process.versions.node}` }
    }
    return {
      area: 'Node.js',
      status: 'fail',
      message: `Node ${process.versions.node} is unsupported`,
      remedy: 'Install Node.js 18 or newer.',
    }
  }

  private checkPackageBuild(projectPath: string): DoctorCheck {
    const distFiles = ['dist/index.mjs', 'dist/cli.js']
    const missing = distFiles.filter((file) => !fs.existsSync(path.join(projectPath, file)))
    if (missing.length === 0) {
      return { area: 'Package', status: 'pass', message: 'Build artifacts are present' }
    }
    return {
      area: 'Package',
      status: 'warn',
      message: `Missing build artifacts: ${missing.join(', ')}`,
      remedy: 'Run `npm run build` before publishing or local CLI use.',
    }
  }

  private async checkOpencodeCommand(): Promise<DoctorCheck> {
    if (await commandExists('opencode')) {
      return { area: 'OpenCode', status: 'pass', message: '`opencode` command is available' }
    }
    return {
      area: 'OpenCode',
      status: 'fail',
      message: '`opencode` command was not found',
      remedy: 'Install OpenCode or add it to PATH, then rerun `better-code-soul setup`.',
    }
  }

  private checkDataDirectory(): DoctorCheck {
    const dataDir = paths.hubData()
    const dbPath = paths.hubDb()
    if (fs.existsSync(dataDir) && fs.existsSync(dbPath)) {
      return { area: 'Storage', status: 'pass', message: 'Data directory and database are ready', detail: dbPath }
    }
    return {
      area: 'Storage',
      status: 'warn',
      message: 'Data directory or database is not initialized yet',
      detail: dataDir,
      remedy: 'Run `/bcs-status` once or `better-code-soul setup` to initialize storage.',
    }
  }

  private checkGlobalConfig(): DoctorCheck {
    const configPath = paths.opencodeConfig()
    if (!fs.existsSync(configPath)) {
      return {
        area: 'Config',
        status: 'warn',
        message: 'Global opencode.json is missing',
        detail: configPath,
        remedy: 'Run `better-code-soul setup`.',
      }
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const plugins = Array.isArray(config.plugin) ? config.plugin : [config.plugin].filter(Boolean)
      const registered = plugins.some((plugin: unknown) => {
        const entry = Array.isArray(plugin) ? plugin[0] : plugin
        return typeof entry === 'string' && (entry === 'better-code-soul' || entry.includes('better-code-soul') || entry.includes('dist/index'))
      })
      const commands = config.command && typeof config.command === 'object' ? config.command as Record<string, unknown> : {}
      const missing = COMMAND_NAMES.filter((name) => !(name in commands))

      if (registered && missing.length === 0) {
        return { area: 'Config', status: 'pass', message: 'Plugin and slash commands are registered', detail: configPath }
      }

      return {
        area: 'Config',
        status: 'warn',
        message: registered ? `Missing commands: ${missing.map((name) => `/${name}`).join(', ')}` : 'better-code-soul plugin is not registered',
        detail: configPath,
        remedy: 'Run `better-code-soul setup`, then restart OpenCode.',
      }
    } catch (err) {
      return {
        area: 'Config',
        status: 'fail',
        message: 'opencode.json is not valid JSON',
        detail: String(err),
        remedy: 'Fix JSON syntax or restore the `.bak` file, then restart OpenCode.',
      }
    }
  }

  private async checkAuth(): Promise<DoctorCheck[]> {
    const providers = await authReader.getProviders(true)
    const connected = providers.filter((provider) => provider.connected)
    const checks: DoctorCheck[] = []

    if (connected.length > 0) {
      checks.push({
        area: 'Auth',
        status: 'pass',
        message: `${connected.length} provider configured`,
        detail: connected.map((provider) => `${provider.name}:${provider.source || 'unknown'}`).join(', '),
      })
    } else {
      checks.push({
        area: 'Auth',
        status: 'warn',
        message: 'No connected provider detected',
        remedy: 'Run `opencode auth login <provider>` or set the provider API key environment variable.',
      })
    }

    for (const error of authReader.getLastErrors()) {
      checks.push({
        area: 'Auth',
        status: 'warn',
        message: error,
        remedy: 'Check `opencode auth status --json` and your opencode.json provider config.',
      })
    }

    return checks
  }

  private async checkGraphify(projectPath: string): Promise<DoctorCheck[]> {
    const installed = await graphifyService.isInstalled()
    const active = graphifyService.isActive(projectPath)
    const stats = graphifyService.getStats(projectPath)
    const checks: DoctorCheck[] = []

    checks.push(installed
      ? { area: 'Graphify', status: 'pass', message: 'Graphify command is installed' }
      : { area: 'Graphify', status: 'warn', message: 'Graphify is not installed', remedy: 'Run `/bcs-graphify install`.' })

    if (active && stats.nodeCount > 0) {
      checks.push({ area: 'Graphify', status: 'pass', message: `Graph is active: ${stats.nodeCount} nodes / ${stats.edgeCount} edges` })
    } else if (active) {
      checks.push({ area: 'Graphify', status: 'warn', message: 'Graphify is active but graph data is empty', remedy: 'Run `/bcs-graphify build`.' })
    } else {
      checks.push({ area: 'Graphify', status: 'warn', message: 'Graphify is inactive for this project', remedy: 'Run `/bcs-graphify enable` after building the graph.' })
    }

    if (active && graphifyService.needsRebuild(projectPath)) {
      checks.push({ area: 'Graphify', status: 'warn', message: 'Graphify graph is stale or missing', remedy: 'Run `/bcs-graphify build`.' })
    }

    return checks
  }

  private async checkContextMode(projectPath: string): Promise<DoctorCheck[]> {
    const installed = await contextModeService.isInstalled()
    const active = contextModeService.isActive(projectPath)
    return [
      installed
        ? { area: 'Context Mode', status: 'pass', message: 'context-mode command is available' }
        : { area: 'Context Mode', status: 'warn', message: 'context-mode is not installed', remedy: 'Run `/bcs-context-mode install`.' },
      active
        ? { area: 'Context Mode', status: 'pass', message: 'Context Mode is active for this project' }
        : { area: 'Context Mode', status: 'warn', message: 'Context Mode is inactive', remedy: 'Run `/bcs-context-mode enable`, then restart OpenCode.' },
    ]
  }

  private checkTokenHistory(): DoctorCheck {
    try {
      const stats = db.getTokenStatsByPeriod(Date.now() - 7 * 86_400_000)
      if (stats.toolCount > 0) {
        return { area: 'Token Tracking', status: 'pass', message: `${stats.toolCount} calls tracked in the last 7 days` }
      }
      return {
        area: 'Token Tracking',
        status: 'warn',
        message: 'No token history yet',
        remedy: 'Run `/bcs-status` after a few tool calls to verify tracking.',
      }
    } catch (err) {
      return {
        area: 'Token Tracking',
        status: 'fail',
        message: 'Token database could not be queried',
        detail: String(err),
        remedy: 'Delete a corrupt `~/.better-code-soul/data.db` only if you accept losing local history.',
      }
    }
  }

  private statusLabel(status: DoctorStatus): string {
    if (status === 'pass') return 'PASS'
    if (status === 'warn') return 'WARN'
    return 'FAIL'
  }

  private escapeTable(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  }
}

export const doctorService = new DoctorService()
