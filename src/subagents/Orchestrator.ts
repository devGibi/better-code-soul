import fs from 'node:fs'
import path from 'node:path'
import { AgentRunner, type AgentConfig, type AgentResult, type AgentType } from './AgentRunner.js'
import { TaskDecomposer, type TaskPlan, type DecomposeContext, type DecomposeDecision } from './TaskDecomposer.js'
import { ResultMerger, type MergedResult } from './ResultMerger.js'
import { CostGuard } from './CostGuard.js'
import { ModelRouter } from '../services/ModelRouter.js'
import { modelRegistry } from '../services/ModelRegistry.js'
import { db } from '../services/Database.js'
import { authReader } from '../services/AuthReader.js'
import { logger } from '../utils/logger.js'

export interface OrchestrationResult extends MergedResult {
  cancelled?: boolean
  reason?: string
  decision?: DecomposeDecision
}

export interface OrchestrationOptions {
  strategy?: 'auto' | 'plan-code-review' | 'parallel-code' | 'sequential'
  maxCost?: number
  decision?: DecomposeDecision
}

export class Orchestrator {
  private agentRunner: AgentRunner
  private taskDecomposer: TaskDecomposer
  private resultMerger: ResultMerger
  private costGuard: CostGuard
  private modelRouter: ModelRouter

  constructor(app?: unknown) {
    this.agentRunner = new AgentRunner(app)
    this.taskDecomposer = new TaskDecomposer()
    this.resultMerger = new ResultMerger()
    this.costGuard = new CostGuard()
    this.modelRouter = new ModelRouter({
      getById: (id) => modelRegistry.getById(id),
      getAllModels: () => modelRegistry.getAllModels(),
    })
  }

  async decompose(userRequest: string, projectPath: string): Promise<DecomposeDecision> {
    try {
      await authReader.getProviders()
    } catch {
      logger.warn('Could not read auth providers for decomposition')
    }

    const contextFiles = await this.getContextFiles(projectPath)
    const availableModels = modelRegistry.getAllModels().map((m) => m.id)

    const decomposeCtx: DecomposeContext = {
      projectPath,
      contextFiles,
      availableModels,
    }

    return this.taskDecomposer.decompose(userRequest, decomposeCtx)
  }

  async run(userRequest: string, projectPath: string, options: OrchestrationOptions = {}): Promise<OrchestrationResult> {
    const startTime = Date.now()

    try {
      await authReader.getProviders()
    } catch {
      logger.warn('Could not read auth providers for orchestration')
    }

    const decision = options.decision || await this.decompose(userRequest, projectPath)

    const plan = this.taskDecomposer.toPlan(decision, userRequest)

    if (options.maxCost) {
      if (decision.estimatedCost > options.maxCost) {
        return {
          cancelled: true,
          reason: `Estimated cost ${decision.estimatedCost.toFixed(4)} exceeds max cost ${options.maxCost.toFixed(4)}`,
          output: '',
          totalTokens: 0,
          totalCost: 0,
          durationMs: Date.now() - startTime,
          modelsUsed: [],
          hasConflicts: false,
          issues: [],
          agentCount: 0,
          decision,
        }
      }
    }

    const costCheck = await this.costGuard.check(decision.estimatedCost)
    if (!costCheck.approved) {
      return {
        cancelled: true,
        reason: costCheck.reason,
        output: '',
        totalTokens: 0,
        totalCost: 0,
        durationMs: Date.now() - startTime,
        modelsUsed: [],
        hasConflicts: false,
        issues: [],
        agentCount: 0,
        decision,
      }
    }

    const connectedModelIds = modelRegistry.getConnectedModelIds()
    const orchId = db.saveOrchestration({
      userRequest,
      agentCount: 0,
      totalTokens: 0,
      totalCost: 0,
      durationMs: 0,
      modelsUsed: [],
      cancelled: false,
    })

    const allResults: AgentResult[] = []

    let planResult: AgentResult | null = null
    if (decision.plannerModel && plan.plannerTask) {
      const routeResult = this.modelRouter.routeAndLog('think', connectedModelIds)
      planResult = await this.agentRunner.run({
        agentType: 'planner',
        model: routeResult.model,
        task: plan.plannerTask,
        context: this.buildContextSummary(decision, projectPath),
        maxTokens: 4000,
      })

      db.saveOrchestrationStep({
        orchestrationId: orchId,
        stepIndex: 0,
        role: 'planner',
        model: routeResult.model.id,
        task: plan.plannerTask,
        inputTokens: planResult.inputTokens,
        outputTokens: planResult.outputTokens,
        cost: planResult.inputTokens * (routeResult.model.inputPrice / 1e6) + planResult.outputTokens * (routeResult.model.outputPrice / 1e6),
        durationMs: planResult.durationMs,
        success: planResult.success,
        error: planResult.error,
      })

      allResults.push(planResult)

      if (!planResult.success) {
        db.updateOrchestration(orchId, {
          agentCount: allResults.length,
          totalTokens: allResults.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0),
          totalCost: 0,
          durationMs: Date.now() - startTime,
          modelsUsed: allResults.map((r) => r.model).filter(Boolean),
          cancelled: true,
          cancelReason: `Planning failed: ${planResult.error}`,
        })
        return {
          cancelled: true,
          reason: `Planning failed: ${planResult.error}`,
          output: '',
          totalTokens: 0,
          totalCost: 0,
          durationMs: Date.now() - startTime,
          modelsUsed: [],
          hasConflicts: false,
          issues: [],
          agentCount: 0,
          decision,
        }
      }
    }

    let coderResults: AgentResult[] = []

    if (plan.coderTasks.length > 0) {
      const codeRouteResult = this.modelRouter.routeAndLog('code', connectedModelIds)
      const coderPromises = plan.coderTasks.map(async (task, i) => {
        const result = await this.agentRunner.run({
          agentType: 'coder',
          model: codeRouteResult.model,
          task: task.task,
          context: [planResult?.output, await this.readRelevantFiles(projectPath, task.files), this.readRulesFile(projectPath)]
            .filter(Boolean)
            .join('\n\n'),
          outputFiles: task.files,
          maxTokens: 3000,
        })

        db.saveOrchestrationStep({
          orchestrationId: orchId,
          stepIndex: i + 1,
          role: `coder_${task.id}`,
          model: codeRouteResult.model.id,
          task: task.task,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: result.inputTokens * (codeRouteResult.model.inputPrice / 1e6) + result.outputTokens * (codeRouteResult.model.outputPrice / 1e6),
          durationMs: result.durationMs,
          success: result.success,
          error: result.error,
        })

        return result
      })

      const settled = await Promise.allSettled(coderPromises)
      const allCoderResults = settled
        .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
        .map((r) => r.value)
      coderResults = allCoderResults.filter((r) => r.success)
      allResults.push(...allCoderResults)
    }

    let reviewResults: AgentResult[] = []

    if (coderResults.length > 0 && decision.reviewerModel) {
      const reviewRouteResult = this.modelRouter.routeAndLog('review', connectedModelIds)
      const reviewPromises = coderResults.map((coderResult, i) => {
        return this.agentRunner.run({
          agentType: 'reviewer',
          model: reviewRouteResult.model,
          task: `Bu kodu incele: tip hatasi, logic hatasi, RULES.md ihlali var mi?\n\n${coderResult.output}`,
          context: coderResult.output,
          maxTokens: 1000,
        }).then(result => {
          db.saveOrchestrationStep({
            orchestrationId: orchId,
            stepIndex: plan.coderTasks.length + i + 1,
            role: `reviewer_${String.fromCharCode(65 + i)}`,
            model: reviewRouteResult.model.id,
            task: 'Review',
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cost: result.inputTokens * (reviewRouteResult.model.inputPrice / 1e6) + result.outputTokens * (reviewRouteResult.model.outputPrice / 1e6),
            durationMs: result.durationMs,
            success: result.success,
            error: result.error,
          })
          return result
        })
      })

      const settled = await Promise.allSettled(reviewPromises)
      const allReviewResults = settled
        .filter((r): r is PromiseFulfilledResult<AgentResult> => r.status === 'fulfilled')
        .map((r) => r.value)
      reviewResults = allReviewResults.filter((r) => r.success)
      allResults.push(...allReviewResults)
    }

    const merged = await this.resultMerger.merge({
      planResult: planResult || { agentId: 'plan_skip', output: '', inputTokens: 0, outputTokens: 0, model: '', durationMs: 0, success: true },
      coderResults,
      reviewResults,
    })
    const durationMs = Date.now() - startTime

    db.updateOrchestration(orchId, {
      agentCount: merged.agentCount,
      totalTokens: merged.totalTokens,
      totalCost: merged.totalCost,
      durationMs,
      modelsUsed: merged.modelsUsed,
      cancelled: false,
    })

    return { ...merged, durationMs, decision }
  }

  private buildContextSummary(decision: DecomposeDecision, projectPath: string): string {
    const parts: string[] = []

    for (const cf of decision.contextFiles) {
      const fullPath = path.join(projectPath, cf.path)
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8')
          const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content
          parts.push(`### ${cf.path}\n${truncated}`)
        } catch {
          // skip unreadable files
        }
      }
    }

    return parts.join('\n\n')
  }

  private async getContextFiles(projectPath: string): Promise<string[]> {
    const candidates = ['RULES.md', 'SPEC.md', 'AGENTS.md', 'README.md', 'package.json']
    const found: string[] = []
    for (const file of candidates) {
      const fullPath = path.join(projectPath, file)
      if (fs.existsSync(fullPath)) {
        found.push(file)
      }
    }
    return found
  }

  private async readRelevantFiles(projectPath: string, files: string[]): Promise<string> {
    if (!files || files.length === 0) return ''
    const contents: string[] = []
    for (const file of files) {
      try {
        const fullPath = path.join(projectPath, file)
        const content = fs.readFileSync(fullPath, 'utf-8')
        const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content
        contents.push(`### ${file}\n${truncated}`)
      } catch {
        // skip unreadable files
      }
    }
    return contents.join('\n\n')
  }

  private readRulesFile(projectPath: string): string {
    const rulesPath = path.join(projectPath, 'RULES.md')
    if (fs.existsSync(rulesPath)) {
      const content = fs.readFileSync(rulesPath, 'utf-8')
      return content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content
    }
    return ''
  }
}
