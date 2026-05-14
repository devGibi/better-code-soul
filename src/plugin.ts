import { db } from './services/Database.js'
import { tokenTracker } from './services/TokenTracker.js'
import { modelRegistry } from './services/ModelRegistry.js'
import { authReader } from './services/AuthReader.js'
import { graphifyService } from './services/GraphifyService.js'
import { contextModeService } from './services/ContextModeService.js'
import { costCalculator } from './services/CostCalculator.js'
import { configPatcher } from './services/ConfigPatcher.js'
import { Orchestrator } from './subagents/Orchestrator.js'
import { onToolBefore } from './hooks/toolBefore.js'
import { onToolAfter } from './hooks/toolAfter.js'
import { onSessionCompact } from './hooks/sessionCompact.js'
import { onSystemTransform } from './hooks/systemTransform.js'
import { formatTokens, formatCost, formatDuration, formatRelativeTime, formatBytes } from './utils/format.js'
import { logger } from './utils/logger.js'

interface PluginTool {
  description: string
  parameters: Record<string, { type: string; description?: string; enum?: string[] }>
  execute: (args: any) => Promise<string>
}

interface PluginDefinition {
  'tool.execute.before'?: (input: { tool: string; input: unknown }) => Promise<void>
  'tool.execute.after'?: (input: { tool: string; input: unknown }, output: unknown) => Promise<void>
  'experimental.session.compacting'?: (session: unknown) => Promise<void>
  'experimental.chat.system.transform'?: (system: string) => Promise<string>
  'chat.message'?: (message: unknown) => Promise<void>
  tool?: Record<string, PluginTool>
}

export const BetterCodeSoulPlugin = async (_app?: unknown): Promise<PluginDefinition> => {
  await db.init()
  modelRegistry.init()
  tokenTracker.init()

  try {
    const providers = await authReader.getProviders()
    modelRegistry.setAuthProviders(providers)
  } catch {
    logger.warn('Could not read auth providers at startup')
  }

  return {
    'tool.execute.before': onToolBefore,
    'tool.execute.after': onToolAfter,
    'experimental.session.compacting': onSessionCompact,
    'experimental.chat.system.transform': onSystemTransform,

    'chat.message': async (message: unknown) => {
      logger.debug('User message received')
    },

    tool: {
      bcs_status: {
        description: 'Better Code Soul general status summary — token, cost, active tools',
        parameters: {},
        execute: async () => {
          const sessionStats = tokenTracker.getSessionStats()
          const todayCost = tokenTracker.getTodayCost()
          const providers = modelRegistry.getAuthProviders()
          const graphifyActive = db.getSetting('graphifyEnabled') === '1'
          const ctxModeActive = db.getSetting('contextModeEnabled') === '1'
          const currentModel = modelRegistry.getBestFor('code')

          const graphStats = graphifyActive ? graphifyService.getStats(process.cwd()) : null
          const ctxStats = ctxModeActive ? await contextModeService.getStats() : null

          let output = `## Better Code Soul — Status\n\n`
          output += `**This Session**\n`
          output += `- Tokens: ${formatTokens(sessionStats.totalInput)} in / ${formatTokens(sessionStats.totalOutput)} out\n`
          output += `- Cost: ${formatCost(sessionStats.totalCost)}\n`
          output += `- Active model: ${currentModel.id} [${currentModel.tier.toUpperCase()}]\n\n`

          output += `**Token Tools**\n`
          if (graphifyActive && graphStats) {
            output += `- Graphify: Active (${formatTokens(graphStats.nodeCount)} nodes · ${formatBytes(graphStats.sizeBytes)})\n`
          } else {
            output += `- Graphify: Inactive\n`
          }
          if (ctxModeActive && ctxStats) {
            output += `- Context Mode: Active (${ctxStats.efficiencyPercent}% efficient · saved: ${ctxStats.savedTotal})\n`
          } else {
            output += `- Context Mode: Inactive\n`
          }
          output += `\n`

          output += `**Connections**\n`
          for (const p of providers) {
            const icon = p.connected ? 'Connected' : 'Not connected'
            output += `- ${p.name}: ${icon}${p.email ? ` (${p.email})` : ''}\n`
          }
          output += `\nDetails: \`/bcs-tokens\`, \`/bcs-models\`, \`/bcs-graphify\`, \`/bcs-context-mode\``

          return output
        },
      },

      bcs_tokens: {
        description: 'Token and cost report for this session or a given period',
        parameters: {
          period: {
            type: 'string',
            description: 'Report period: session, today, week, month',
            enum: ['session', 'today', 'week', 'month'],
          },
        },
        execute: async ({ period = 'session' }) => {
          const now = Date.now()
          let startTs = 0
          let label = 'Session'

          switch (period) {
            case 'today':
              startTs = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
              label = 'Today'
              break
            case 'week':
              startTs = now - 7 * 86_400_000
              label = 'This Week'
              break
            case 'month':
              startTs = now - 30 * 86_400_000
              label = 'This Month'
              break
            default:
              startTs = 0
              label = 'Session'
          }

          const stats = db.getTokenStatsByPeriod(startTs)
          const dailyStats = db.getDailyStats(period === 'month' ? 30 : period === 'week' ? 7 : 1)

          let output = `## Token Report — ${label}\n\n`

          if (dailyStats.length > 0) {
            output += `| Day | Tokens | Cost | Models |\n`
            output += `|-----|--------|------|--------|\n`
            for (const day of dailyStats) {
              output += `| ${day.date} | ${formatTokens(day.tokens)} | ${formatCost(day.cost)} | ${day.models.join(', ') || '-'} |\n`
            }
            output += `\n`
          }

          output += `**Total: ${formatTokens(stats.totalInput + stats.totalOutput)} tokens · ${formatCost(stats.totalCost)}**\n`
          output += `- Input: ${formatTokens(stats.totalInput)} · Output: ${formatTokens(stats.totalOutput)}\n`
          output += `- Tool calls: ${stats.toolCount}\n\n`
          output += `Optimization: \`/bcs-optimize\``

          return output
        },
      },

      bcs_models: {
        description: 'Available models, auth status, and price comparison',
        parameters: {
          filter: {
            type: 'string',
            description: 'Which models to show: all, connected, catalog',
            enum: ['all', 'connected', 'catalog'],
          },
        },
        execute: async ({ filter = 'all' }) => {
          const providers = modelRegistry.getAuthProviders()
          const connectedNames = providers.filter((p) => p.connected).map((p) => p.name)
          const allModels = modelRegistry.getAllModels()

          const connected = allModels.filter((m) =>
            connectedNames.some((n) => m.provider === n || m.provider.startsWith(n))
          )
          const catalogOnly = allModels.filter((m) => !connectedNames.some((n) => m.provider === n || m.provider.startsWith(n)))

          let output = `## Available Models\n\n`

          if (filter === 'all' || filter === 'connected') {
            output += `### Connected\n`
            if (connected.length === 0) {
              output += `_No connected models found._\n\n`
            } else {
              output += `| Model | Tier | Ctx | Price (in/out) |\n`
              output += `|-------|------|-----|----------------|\n`
              for (const m of connected) {
                const ctx = m.contextWindow >= 1000000 ? `${m.contextWindow / 1000000}M` : `${m.contextWindow / 1000}K`
                output += `| ${m.id} | ${m.tier} | ${ctx} | $${m.inputPrice}/$${m.outputPrice} |\n`
              }
              output += `\n`
            }
          }

          if (filter === 'all' || filter === 'catalog') {
            output += `### Catalog (not connected)\n`
            if (catalogOnly.length === 0) {
              output += `_All catalog models are connected._\n\n`
            } else {
              output += `| Model | Tier | Price | How to Connect |\n`
              output += `|-------|------|-------|----------------|\n`
              for (const m of catalogOnly) {
                output += `| ${m.id} | ${m.tier} | $${m.inputPrice}/$${m.outputPrice} | ${m.authMethod.join(', ')} |\n`
              }
              output += `\n`
            }
          }

          output += `Connect models: \`opencode auth login <provider>\``
          return output
        },
      },

      bcs_graphify: {
        description: 'Graphify memory system management — install, build, toggle',
        parameters: {
          action: {
            type: 'string',
            description: 'Action to perform',
            enum: ['status', 'install', 'build', 'update', 'enable', 'disable'],
          },
        },
        execute: async ({ action }) => {
          const projectPath = process.cwd()
          const installed = await graphifyService.isInstalled()

          switch (action) {
            case 'status': {
              const stats = graphifyService.getStats(projectPath)
              let output = `## Graphify — Memory System\n\n`
              output += `**Status:** ${stats.installed ? 'Installed' : 'Not installed'}\n`
              if (stats.installed) {
                output += `**Nodes:** ${stats.nodeCount} · **Edges:** ${stats.edgeCount}\n`
                output += `**Files:** ${stats.fileCount} · **Size:** ${formatBytes(stats.sizeBytes)}\n`
                if (stats.lastBuilt) {
                  output += `**Last built:** ${formatRelativeTime(stats.lastBuilt)}\n`
                }
              }
              output += `\nUsage:\n- \`/bcs-graphify build\` → create/update graph\n- \`/bcs-graphify enable\` → activate for this project\n- \`/bcs-graphify disable\` → deactivate`
              return output
            }

            case 'install': {
              if (installed) return 'Graphify is already installed.'
              const lines: string[] = []
              for await (const line of graphifyService.install()) {
                lines.push(line)
              }
              return '## Graphify Install\n\n' + lines.join('\n')
            }

            case 'build': {
              if (!installed) return 'Graphify is not installed. Run: `/bcs-graphify install`'
              const lines: string[] = []
              for await (const line of graphifyService.build(projectPath)) {
                lines.push(line)
              }
              return '## Graphify Build\n\n' + lines.join('\n')
            }

            case 'enable': {
              graphifyService.enable(projectPath)
              return 'Graphify enabled for this project.'
            }

            case 'disable': {
              graphifyService.disable(projectPath)
              return 'Graphify disabled for this project.'
            }

            default:
              return `Unknown action: ${action}`
          }
        },
      },

      bcs_context_mode: {
        description: 'Context Mode token savings management — install, toggle, stats',
        parameters: {
          action: {
            type: 'string',
            description: 'Action to perform',
            enum: ['status', 'install', 'enable', 'disable', 'stats', 'doctor'],
          },
        },
        execute: async ({ action }) => {
          const projectPath = process.cwd()

          switch (action) {
            case 'status': {
              const installed = await contextModeService.isInstalled()
              const active = contextModeService.isActive(projectPath)
              let output = `## Context Mode\n\n`
              output += `**Installed:** ${installed ? 'Yes' : 'No'}\n`
              output += `**Active:** ${active ? 'Yes' : 'No'}\n`
              if (active) {
                const stats = await contextModeService.getStats()
                output += `**Saved this session:** ${stats.savedThisSession}\n`
                output += `**Total saved:** ${stats.savedTotal}\n`
                output += `**Efficiency:** ${stats.efficiencyPercent}%\n`
              }
              output += `\nUsage:\n- \`/bcs-context-mode install\` → install globally\n- \`/bcs-context-mode enable\` → activate for this project\n- \`/bcs-context-mode stats\` → detailed stats\n- \`/bcs-context-mode doctor\` → run diagnostics`
              return output
            }

            case 'install': {
              const lines: string[] = []
              for await (const line of contextModeService.install()) {
                lines.push(line)
              }
              return '## Context Mode Install\n\n' + lines.join('\n')
            }

            case 'enable': {
              contextModeService.enable(projectPath)
              return 'Context Mode enabled for this project.'
            }

            case 'disable': {
              contextModeService.disable(projectPath)
              return 'Context Mode disabled for this project.'
            }

            case 'stats': {
              const stats = await contextModeService.getStats()
              return `## Context Mode Stats\n\n- Saved this session: ${stats.savedThisSession}\n- Total saved: ${stats.savedTotal}\n- Efficiency: ${stats.efficiencyPercent}%`
            }

            case 'doctor': {
              const result = await contextModeService.runDoctor()
              return `## Context Mode Doctor\n\n${result}`
            }

            default:
              return `Unknown action: ${action}`
          }
        },
      },

      bcs_optimize: {
        description: 'Generate token optimization suggestions based on usage data',
        parameters: {},
        execute: async () => {
          const stats = db.getSessionStats()
          const suggestions: string[] = []

          const rules = [
            {
              id: 'think_overuse',
              check: () => stats.thinkTierRatio > 0.6,
              message: () =>
                `PLAN tier usage is ${Math.round(stats.thinkTierRatio * 100)}%. Use sonnet-4-5 or kimi-k2 for code generation. Estimated savings: ~70% of think-tier cost.`,
            },
            {
              id: 'no_review_tier',
              check: () => stats.reviewTierUsage === 0,
              message: () =>
                'REVIEW tier never used. Add haiku-4-5 or gpt-4o-mini for validation tasks. Up to 70% cost reduction possible.',
            },
            {
              id: 'high_session_cost',
              check: () => stats.avgSessionCost > 0.5,
              message: () =>
                `Average session cost is ${formatCost(stats.avgSessionCost)}. Break tasks into smaller sessions focused on a single topic.`,
            },
            {
              id: 'graphify_not_active',
              check: () => !stats.graphifyActive && stats.projectFileCount > 30,
              message: () =>
                'Project has 30+ files but Graphify is not active. Enable it to let the model query the graph instead of reading all files. Run: `/bcs-graphify install`',
            },
            {
              id: 'context_mode_not_active',
              check: () => !stats.contextModeActive,
              message: () =>
                'Context Mode is not active. Tool outputs enter context raw. Enable it: `/bcs-context-mode enable`. Expected savings: ~98% tool output reduction.',
            },
            {
              id: 'mixed_providers',
              check: () => stats.providerCount > 2,
              message: () =>
                'Multiple providers in use. Optimize tier-model mapping: PLAN → gemini-2.5-pro, CODE → kimi-k2/deepseek-v3, REVIEW → gpt-4o-mini/haiku-4-5.',
            },
          ]

          for (const rule of rules) {
            if (rule.check()) {
              suggestions.push(rule.message())
            }
          }

          if (suggestions.length === 0) {
            return '## Optimization\n\nNo optimization suggestions — your usage looks efficient!'
          }

          let output = `## Optimization Suggestions\n\n`
          for (let i = 0; i < suggestions.length; i++) {
            output += `${i + 1}. ${suggestions[i]}\n\n`
          }
          output += `Detailed token report: \`/bcs-tokens\``
          return output
        },
      },

      bcs_agent: {
        description: 'Dispatch task to parallel subagent orchestration. Use for large features or refactors.',
        parameters: {
          request: {
            type: 'string',
            description: 'What do you want to do? (Turkish or English)',
          },
          strategy: {
            type: 'string',
            description: 'Orchestration strategy (default: auto)',
            enum: ['auto', 'plan-code-review', 'parallel-code', 'sequential'],
          },
          maxCost: {
            type: 'number',
            description: 'Maximum spending limit in USD (default: daily limit from settings)',
          },
        },
        execute: async ({ request, strategy = 'auto', maxCost }) => {
          const orchestrator = new Orchestrator()
          const result = await orchestrator.run(request, process.cwd(), { strategy: strategy as any, maxCost })

          if (result.cancelled) {
            return `Cancelled: ${result.reason}`
          }

          let output = `## Orchestration Complete\n\n`
          output += `**Models used:** ${result.modelsUsed.join(', ')}\n`
          output += `**Parallel agents:** ${result.agentCount}\n`
          output += `**Total tokens:** ${result.totalTokens.toLocaleString()}\n`
          output += `**Total cost:** ${formatCost(result.totalCost)}\n`
          output += `**Duration:** ${(result.durationMs / 1000).toFixed(0)}s\n\n`

          if (result.hasConflicts) {
            output += `Warning: File conflicts detected — review below.\n\n`
          }

          output += `---\n\n${result.output}`
          return output
        },
      },
    },
  }
}
