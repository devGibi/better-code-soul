import { tokenTracker, parseTokensFromOutput } from '../services/TokenTracker.js'
import { logger } from '../utils/logger.js'

export async function onToolAfter(
  input: { tool: string; input: unknown },
  output: unknown
): Promise<void> {
  try {
    const tokens = parseTokensFromOutput(output)
    tokenTracker.recordToolEnd(input.tool, tokens, output)
    logger.debug('tool.execute.after', { tool: input.tool, tokens })
  } catch (err) {
    logger.error('Error in toolAfter hook', err)
  }
}
