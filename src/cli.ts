#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const command = args[0]

const BCS_COMMANDS: Record<string, { description: string; template: string }> = {
  'bcs': {
    description: 'Better Code Soul web dashboard ac',
    template: 'Call the bcs tool to open the web dashboard.',
  },
  'bcs-status': {
    description: 'Better Code Soul genel durum ozeti',
    template: 'Call the bcs_status tool and return only its output.',
  },
  'bcs-tokens': {
    description: 'Better Code Soul token ve maliyet raporu',
    template: 'Call the bcs_tokens tool with period set to "$ARGUMENTS" if provided, otherwise "session". Return only its output.',
  },
  'bcs-models': {
    description: 'Better Code Soul model ve auth durumu',
    template: 'Call the bcs_models tool with filter set to "$ARGUMENTS" if provided, otherwise "all". Return only its output.',
  },
  'bcs-graphify': {
    description: 'Graphify hafiza sistemi yonetimi',
    template: 'Call the bcs_graphify tool with action set to "$ARGUMENTS" if provided, otherwise "status". Return only its output.',
  },
  'bcs-context-mode': {
    description: 'Context Mode token tasarrufu yonetimi',
    template: 'Call the bcs_context_mode tool with action set to "$ARGUMENTS" if provided, otherwise "status". Return only its output.',
  },
  'bcs-optimize': {
    description: 'Better Code Soul optimizasyon onerileri',
    template: 'Call the bcs_optimize tool and return only its output.',
  },
  'bcs-doctor': {
    description: 'Better Code Soul kurulum ve saglik kontrolu',
    template: 'Call the bcs_doctor tool and return only its output.',
  },
  'bcs-agent': {
    description: 'Gorevi paralel subagentlara dagit',
    template: 'Call the bcs_agent tool with request set to "$ARGUMENTS". Return only its output.',
  },
}

function getConfigPath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
}

function getHubDataPath(): string {
  return path.join(os.homedir(), '.better-code-soul')
}

function isBetterCodeSoulPlugin(entry: unknown): boolean {
  const plugin = Array.isArray(entry) ? entry[0] : entry
  if (typeof plugin !== 'string') return false

  if (plugin === 'better-code-soul' || plugin.startsWith('better-code-soul@')) {
    return true
  }

  if (plugin.startsWith('file://')) {
    try {
      const pluginPath = path.resolve(fileURLToPath(plugin))
      const localDist = path.resolve(process.cwd(), 'dist', 'index.mjs')
      return pluginPath === localDist && fs.existsSync(pluginPath)
    } catch {
      return false
    }
  }

  return false
}

function setup(): void {
  console.log('Setting up Better Code Soul...\n')

  const configPath = getConfigPath()
  const configDir = path.dirname(configPath)

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  let config: Record<string, unknown> & {
    plugin?: unknown[]
    command?: Record<string, { description: string; template: string; prompt?: string }>
  } = {}
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      config = {}
    }
  }

  if (!config.plugin) {
    config.plugin = []
  }
  if (!Array.isArray(config.plugin)) {
    config.plugin = [config.plugin]
  }
  let changed = false
  if (!config.$schema) {
    config.$schema = 'https://opencode.ai/config.json'
    changed = true
  }
  if (!config.plugin.some(isBetterCodeSoulPlugin)) {
    config.plugin.push('better-code-soul')
    changed = true
    console.log('  Added "better-code-soul" to opencode.json plugins')
  } else {
    console.log('  "better-code-soul" already registered in opencode.json')
  }

  if (!config.command || typeof config.command !== 'object' || Array.isArray(config.command)) {
    config.command = {}
    changed = true
  }
  for (const [name, commandConfig] of Object.entries(BCS_COMMANDS)) {
    const current = config.command[name]
    if (!current || current.description !== commandConfig.description || current.template !== commandConfig.template || current.prompt) {
      config.command[name] = commandConfig
      changed = true
      console.log(`  Registered /${name}`)
    }
  }

  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  const hubData = getHubDataPath()
  if (!fs.existsSync(hubData)) {
    fs.mkdirSync(hubData, { recursive: true })
  }
  const logsDir = path.join(hubData, 'logs')
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  console.log(`  Data directory: ${hubData}`)
  console.log(`  Config: ${configPath}`)
  console.log('\nSetup complete. Quit and restart OpenCode, then run: /bcs-doctor')
}

function status(): void {
  const hubData = getHubDataPath()
  const dbPath = path.join(hubData, 'data.db')
  const configPath = getConfigPath()

  console.log('Better Code Soul Status\n')
  console.log(`  Data dir: ${hubData} ${fs.existsSync(hubData) ? 'OK' : 'MISSING'}`)
  console.log(`  Database: ${dbPath} ${fs.existsSync(dbPath) ? 'OK' : 'MISSING'}`)
  console.log(`  Config:   ${configPath} ${fs.existsSync(configPath) ? 'OK' : 'MISSING'}`)

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const plugins = Array.isArray(config.plugin) ? config.plugin : [config.plugin]
      const registered = plugins.some(isBetterCodeSoulPlugin)
      console.log(`  Plugin:   ${registered ? 'Registered' : 'NOT registered'}`)
      const commands = config.command && typeof config.command === 'object' ? config.command : {}
      const missingCommands = Object.keys(BCS_COMMANDS).filter((name) => !(name in commands))
      console.log(`  Commands: ${missingCommands.length === 0 ? 'Registered' : `Missing ${missingCommands.map((name) => `/${name}`).join(', ')}`}`)
    } catch {
      console.log('  Plugin:   Could not read config')
    }
  }
}

async function dashboard(): Promise<void> {
  const { startDashboardServer } = await import('./web/DashboardServer.js')
  const handle = await startDashboardServer({ openBrowser: true, initializeServices: true })
  console.log('Better Code Soul dashboard')
  console.log(`  URL: ${handle.url}`)
  console.log(`  Browser: ${handle.opened ? 'opened' : 'open manually'}`)
  console.log('\nPress Ctrl+C to stop the dashboard server.')
}

async function doctor(): Promise<void> {
  const { db } = await import('./services/Database.js')
  const { modelRegistry } = await import('./services/ModelRegistry.js')
  const { tokenTracker } = await import('./services/TokenTracker.js')
  const { authReader } = await import('./services/AuthReader.js')
  const { doctorService } = await import('./services/DoctorService.js')

  await db.init()
  modelRegistry.init()
  tokenTracker.init()
  modelRegistry.setAuthProviders(await authReader.getProviders(true))

  const report = await doctorService.run(process.cwd())
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(doctorService.formatMarkdown(report))
  }
  db.close()
}

function help(): void {
  console.log(`
Better Code Soul — OpenCode plugin for token tracking and parallel subagent orchestration

Usage:
  better-code-soul setup     Register plugin with OpenCode
  better-code-soul status    Check installation status
  better-code-soul doctor    Run install/auth/tool diagnostics
  better-code-soul dashboard Open web dashboard
  better-code-soul mcp       Start MCP server (stdio)
  better-code-soul help      Show this help

OpenCode Commands (after setup):
  /bcs                 Open web dashboard
  /bcs-status          General status summary
  /bcs-tokens [period] Token and cost report
  /bcs-models          Available models
  /bcs-agent "task"    Parallel subagent orchestration
  /bcs-graphify        Graphify memory system
  /bcs-context-mode    Context Mode management
  /bcs-optimize        Optimization suggestions
  /bcs-doctor          Install/auth/tool diagnostics
`)
}

switch (command) {
  case 'setup':
    setup()
    break
  case 'status':
    status()
    break
  case 'doctor':
    doctor().catch((err) => {
      console.error(`Doctor failed: ${err}`)
      process.exit(1)
    })
    break
  case 'dashboard':
    dashboard().catch((err) => {
      console.error(`Dashboard failed: ${err}`)
      process.exit(1)
    })
    break
  case 'mcp':
    import('./mcp/server.js')
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    help()
    break
  default:
    console.error(`Unknown command: ${command}`)
    help()
    process.exit(1)
}
