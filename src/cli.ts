#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const command = args[0]

const BCS_COMMANDS: Record<string, { description: string; prompt: string }> = {
  'bcs-status': {
    description: 'Better Code Soul genel durum ozeti',
    prompt: 'Call the bcs_status tool and show the result directly.',
  },
  'bcs-tokens': {
    description: 'Better Code Soul token ve maliyet raporu',
    prompt: 'Call the bcs_tokens tool. If the user supplied an argument, use it as the period; otherwise use session.',
  },
  'bcs-models': {
    description: 'Better Code Soul model ve auth durumu',
    prompt: 'Call the bcs_models tool. If the user supplied an argument, use it as the filter; otherwise use all.',
  },
  'bcs-graphify': {
    description: 'Graphify hafiza sistemi yonetimi',
    prompt: 'Call the bcs_graphify tool. Use the user argument as action; if missing, use status.',
  },
  'bcs-context-mode': {
    description: 'Context Mode token tasarrufu yonetimi',
    prompt: 'Call the bcs_context_mode tool. Use the user argument as action; if missing, use status.',
  },
  'bcs-optimize': {
    description: 'Better Code Soul optimizasyon onerileri',
    prompt: 'Call the bcs_optimize tool and show the result directly.',
  },
  'bcs-agent': {
    description: 'Gorevi paralel subagentlara dagit',
    prompt: 'Call the bcs_agent tool. Use the full user argument as request. If no request was supplied, ask the user for the task.',
  },
}

function getConfigPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode', 'opencode.json')
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'opencode.json')
    default:
      return path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  }
}

function getHubDataPath(): string {
  return path.join(os.homedir(), '.better-code-soul')
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
    command?: Record<string, { description: string; prompt: string }>
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
  if (!config.plugin.includes('better-code-soul')) {
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
    if (!current || current.description !== commandConfig.description || current.prompt !== commandConfig.prompt) {
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
  console.log('\nSetup complete. Quit and restart OpenCode, then run: /bcs-status')
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
      const registered = plugins.includes('better-code-soul')
      console.log(`  Plugin:   ${registered ? 'Registered' : 'NOT registered'}`)
      const commands = config.command && typeof config.command === 'object' ? config.command : {}
      const missingCommands = Object.keys(BCS_COMMANDS).filter((name) => !(name in commands))
      console.log(`  Commands: ${missingCommands.length === 0 ? 'Registered' : `Missing ${missingCommands.map((name) => `/${name}`).join(', ')}`}`)
    } catch {
      console.log('  Plugin:   Could not read config')
    }
  }
}

function help(): void {
  console.log(`
Better Code Soul — OpenCode plugin for token tracking and parallel subagent orchestration

Usage:
  better-code-soul setup     Register plugin with OpenCode
  better-code-soul status    Check installation status
  better-code-soul mcp       Start MCP server (stdio)
  better-code-soul help      Show this help

OpenCode Commands (after setup):
  /bcs-status          General status summary
  /bcs-tokens [period] Token and cost report
  /bcs-models          Available models
  /bcs-agent "task"    Parallel subagent orchestration
  /bcs-graphify        Graphify memory system
  /bcs-context-mode    Context Mode management
  /bcs-optimize        Optimization suggestions
`)
}

switch (command) {
  case 'setup':
    setup()
    break
  case 'status':
    status()
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
