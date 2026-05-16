import readline from 'node:readline'
import { db } from '../services/Database.js'
import { tokenTracker } from '../services/TokenTracker.js'
import { modelRegistry } from '../services/ModelRegistry.js'
import { authReader } from '../services/AuthReader.js'
import { graphifyService } from '../services/GraphifyService.js'
import { contextModeService } from '../services/ContextModeService.js'
import { doctorService } from '../services/DoctorService.js'
import { Orchestrator } from '../subagents/Orchestrator.js'
import { formatTokens, formatCost, formatDuration } from '../utils/format.js'
import { logger } from '../utils/logger.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

const orchestrator = new Orchestrator()

const TOOLS: Record<string, { description: string; inputSchema: unknown; handler: (args: Record<string, unknown>) => Promise<string> }> = {
  bcs_status: {
    description: 'General status summary — token, cost, active tools',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const stats = tokenTracker.getSessionStats()
      const providers = modelRegistry.getAuthProviders()
      const currentModel = modelRegistry.getBestFor('code')
      let output = `Session: ${formatTokens(stats.totalInput)} in / ${formatTokens(stats.totalOutput)} out, ${formatCost(stats.totalCost)}\n`
      output += `Model: ${currentModel.id}\n`
      output += `Providers: ${providers.map((p) => `${p.name}:${p.connected ? 'connected' : 'disconnected'}`).join(', ')}`
      return output
    },
  },
  bcs_tokens: {
    description: 'Token and cost report',
    inputSchema: { type: 'object', properties: { period: { type: 'string', enum: ['session', 'today', 'week', 'month'] } } },
    handler: async (args) => {
      const period = (args.period as string) || 'session'
      const now = Date.now()
      let startTs = 0
      switch (period) {
        case 'today': startTs = new Date().setHours(0, 0, 0, 0); break
        case 'week': startTs = now - 7 * 86_400_000; break
        case 'month': startTs = now - 30 * 86_400_000; break
      }
      const stats = db.getTokenStatsByPeriod(startTs)
      return `Tokens: ${formatTokens(stats.totalInput + stats.totalOutput)}, Cost: ${formatCost(stats.totalCost)}, Calls: ${stats.toolCount}`
    },
  },
  bcs_models: {
    description: 'Available models and auth status',
    inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['all', 'connected', 'catalog'] } } },
    handler: async (args) => {
      const filter = (args.filter as string) || 'all'
      const allModels = modelRegistry.getAllModels()
      const connected = modelRegistry.getConnectedModels()
      const models = filter === 'connected' ? connected : allModels
      return models.map((m) => `${m.id} [${m.tier}] $${m.inputPrice}/$${m.outputPrice}`).join('\n')
    },
  },
  bcs_graphify: {
    description: 'Graphify memory system management',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'build', 'enable', 'disable'] } } },
    handler: async (args) => {
      const action = (args.action as string) || 'status'
      const projectPath = process.cwd()
      switch (action) {
        case 'status': {
          const stats = graphifyService.getStats(projectPath)
          return `Nodes: ${stats.nodeCount}, Edges: ${stats.edgeCount}, Files: ${stats.fileCount}`
        }
        case 'enable':
          graphifyService.enable(projectPath)
          return 'Graphify enabled'
        case 'disable':
          graphifyService.disable(projectPath)
          return 'Graphify disabled'
        default:
          return `Unknown action: ${action}`
      }
    },
  },
  bcs_context_mode: {
    description: 'Context Mode management',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'enable', 'disable', 'stats'] } } },
    handler: async (args) => {
      const action = (args.action as string) || 'status'
      const projectPath = process.cwd()
      switch (action) {
        case 'status': {
          const active = contextModeService.isActive(projectPath)
          return `Active: ${active}`
        }
        case 'enable':
          contextModeService.enable(projectPath)
          return 'Context Mode enabled'
        case 'disable':
          contextModeService.disable(projectPath)
          return 'Context Mode disabled'
        case 'stats': {
          const stats = await contextModeService.getStats()
          return `Saved: ${stats.savedTotal}, Efficiency: ${stats.efficiencyPercent}%`
        }
        default:
          return `Unknown action: ${action}`
      }
    },
  },
  bcs_doctor: {
    description: 'Install, auth, storage, and tool diagnostics',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const report = await doctorService.run(process.cwd())
      return doctorService.formatMarkdown(report)
    },
  },
  bcs_quality: {
    description: 'Quality loop report — success score, model performance, cost per successful task',
    inputSchema: { type: 'object', properties: { period: { type: 'string', enum: ['week', 'month'] } } },
    handler: async (args) => {
      const days = args.period === 'week' ? 7 : 30
      const summary = db.getQualitySummary(days)
      const models = db.getModelPerformanceHistory(days).slice(0, 8)
      const lines = [
        `Quality runs: ${summary.totalRuns}`,
        `Avg score: ${summary.avgSuccessScore.toFixed(1)}/100`,
        `Success rate: ${(summary.successRate * 100).toFixed(0)}%`,
        `Cost/successful task: ${formatCost(summary.avgCostPerSuccessfulTask)}`,
        `Retry rate: ${(summary.retryRate * 100).toFixed(0)}%`,
      ]
      if (models.length > 0) {
        lines.push('', 'Model performance:')
        for (const model of models) {
          lines.push(`${model.model}/${model.role}: ${model.runs} runs, ${(model.successRate * 100).toFixed(0)}%, ${formatCost(model.avgCost)}, ${formatDuration(model.avgDurationMs)}`)
        }
      }
      return lines.join('\n')
    },
  },
  bcs_agent: {
    description: 'Dispatch task to parallel subagent orchestration',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Task to execute' },
        strategy: { type: 'string', enum: ['auto', 'plan-code-review', 'parallel-code', 'sequential'] },
        maxCost: { type: 'number', description: 'Maximum cost limit in USD' },
      },
      required: ['request'],
    },
    handler: async (args) => {
      const request = args.request as string
      const strategy = (args.strategy as string) || 'auto'
      const maxCost = args.maxCost as number | undefined

      const result = await orchestrator.run(request, process.cwd(), { strategy: strategy as any, maxCost })

      if (result.cancelled) {
        return `Cancelled: ${result.reason}`
      }

      return [
        `Orchestration complete`,
        `Models: ${result.modelsUsed.join(', ')}`,
        `Agents: ${result.agentCount}`,
        `Tokens: ${result.totalTokens.toLocaleString()}`,
        `Cost: ${formatCost(result.totalCost)}`,
        result.quality ? `Quality: ${result.quality.score}/100 (${result.quality.passed ? 'PASS' : 'FAIL'}), cost/successful task ${formatCost(result.quality.costPerSuccessfulTask)}` : '',
        `Duration: ${(result.durationMs / 1000).toFixed(0)}s`,
        '',
        result.output,
      ].join('\n')
    },
  },
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  try {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'better-code-soul', version: '0.1.0' },
          },
        }

      case 'notifications/initialized':
        return { jsonrpc: '2.0', id: req.id, result: {} }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            tools: Object.entries(TOOLS).map(([name, tool]) => ({
              name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        }

      case 'tools/call': {
        const params = req.params as { name: string; arguments?: Record<string, unknown> }
        const tool = TOOLS[params.name]
        if (!tool) {
          return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Unknown tool: ${params.name}` } }
        }
        const result = await tool.handler(params.arguments || {})
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: result }] },
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id: req.id, result: {} }

      default:
        return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } }
    }
  } catch (err) {
    logger.error('MCP request error', err)
    return { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(err) } }
  }
}

async function main(): Promise<void> {
  await db.init()
  modelRegistry.init()
  tokenTracker.init()

  try {
    const providers = await authReader.getProviders()
    modelRegistry.setAuthProviders(providers)
  } catch {
    // ignore
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

  rl.on('line', async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return

    try {
      const req: JsonRpcRequest = JSON.parse(trimmed)
      const res = await handleRequest(req)
      process.stdout.write(JSON.stringify(res) + '\n')
    } catch {
      const errorRes: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32700, message: 'Parse error' },
      }
      process.stdout.write(JSON.stringify(errorRes) + '\n')
    }
  })

  rl.on('close', () => {
    db.close()
    process.exit(0)
  })
}

main().catch((err) => {
  process.stderr.write(`BCS MCP server error: ${err}\n`)
  process.exit(1)
})
