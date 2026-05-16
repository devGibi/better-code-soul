import type { Model } from './ModelRegistry.js'

export interface TokenUsage {
  input: number
  output: number
  model?: string
  total?: number
  source?: 'provider' | 'opencode' | 'regex' | 'estimate' | 'none'
  confidence?: 'high' | 'medium' | 'low'
}

export class CostCalculator {
  calculate(tokens: TokenUsage, model: Model): number {
    const inputCost = (tokens.input / 1_000_000) * model.inputPrice
    const outputCost = (tokens.output / 1_000_000) * model.outputPrice
    return inputCost + outputCost
  }

  estimateForTier(
    tier: 'think' | 'code' | 'review',
    avgInputTokens: number,
    avgOutputTokens: number,
    model: Model
  ): number {
    return this.calculate({ input: avgInputTokens, output: avgOutputTokens }, model)
  }

  estimateOrchestration(params: {
    plannerTokens: { input: number; output: number }
    coderCount: number
    coderTokens: { input: number; output: number }
    reviewerCount: number
    reviewerTokens: { input: number; output: number }
    plannerModel: Model
    coderModel: Model
    reviewerModel: Model
  }): number {
    const plannerCost = this.calculate(params.plannerTokens, params.plannerModel)
    const coderCost = this.calculate(params.coderTokens, params.coderModel) * params.coderCount
    const reviewerCost = this.calculate(params.reviewerTokens, params.reviewerModel) * params.reviewerCount
    return plannerCost + coderCost + reviewerCost
  }
}

export const costCalculator = new CostCalculator()
