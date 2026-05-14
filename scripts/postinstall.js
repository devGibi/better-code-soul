#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')

function getConfigPath() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode', 'opencode.json')
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'opencode.json')
    default:
      return path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  }
}

function getHubDataPath() {
  return path.join(os.homedir(), '.better-code-soul')
}

const BCS_COMMANDS = {
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

try {
  const configPath = getConfigPath()
  const configDir = path.dirname(configPath)

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  let config = {}
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

  console.log('\x1b[32m%s\x1b[0m', '✅ Better Code Soul installed successfully.')
  console.log('   Quit and restart OpenCode, then run: /bcs-status')
} catch (err) {
  console.warn('\x1b[33m%s\x1b[0m', '⚠ Better Code Soul postinstall: could not auto-register plugin.')
  console.warn('   Manual setup: run `better-code-soul setup` or add the plugin and command entries to opencode.json.')
  console.warn('   Error:', err.message)
}
