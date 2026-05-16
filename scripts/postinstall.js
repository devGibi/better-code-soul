#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')

function getConfigPath() {
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
}

function getHubDataPath() {
  return path.join(os.homedir(), '.better-code-soul')
}

const BCS_COMMANDS = {
  'bcs': {
    description: 'Better Code Soul yonetim panelini ac',
    template: 'Call the bcs tool to open the dashboard.',
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
  'bcs-quality': {
    description: 'Better Code Soul kalite ve basari raporu',
    template: 'Call the bcs_quality tool with period set to "$ARGUMENTS" if provided, otherwise "month". Return only its output.',
  },
  'bcs-agent': {
    description: 'Gorevi paralel subagentlara dagit',
    template: 'Call the bcs_agent tool with request set to "$ARGUMENTS". Return only its output.',
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
    if (!current || current.description !== commandConfig.description || current.template !== commandConfig.template || current.prompt) {
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
  console.log('   Quit and restart OpenCode, then run: /bcs-doctor')
} catch (err) {
  console.warn('\x1b[33m%s\x1b[0m', '⚠ Better Code Soul postinstall: could not auto-register plugin.')
  console.warn('   Manual setup: run `better-code-soul setup` or add the plugin and command entries to opencode.json.')
  console.warn('   Error:', err.message)
}
