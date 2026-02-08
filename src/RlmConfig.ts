import { Context } from "effect"

export interface RlmConfigService {
  readonly maxIterations: number
  readonly maxDepth: number
  readonly maxLlmCalls: number
  readonly maxTotalTokens: number | null
  readonly concurrency: number
  readonly eventBufferCapacity: number
  readonly maxExecutionOutputChars: number
  readonly subModelContextChars?: number
  readonly bridgeToolRetryCount?: number
  readonly bridgeLlmQueryRetryCount?: number
  readonly bridgeRetryBaseDelayMs?: number
}

export class RlmConfig extends Context.Reference<RlmConfig>()(
  "@recursive-llm/RlmConfig",
  {
    defaultValue: (): RlmConfigService => ({
      maxIterations: 10,
      maxDepth: 1,
      maxLlmCalls: 20,
      maxTotalTokens: null,
      concurrency: 4,
      eventBufferCapacity: 4096,
      maxExecutionOutputChars: 8_000,
      bridgeToolRetryCount: 1,
      bridgeLlmQueryRetryCount: 1,
      bridgeRetryBaseDelayMs: 50
    })
  }
) {}
