import { Context } from "effect"

export interface RlmConfigService {
  readonly maxIterations: number
  readonly maxDepth: number
  readonly maxLlmCalls: number
  readonly maxTotalTokens: number | null
  readonly concurrency: number
  readonly commandQueueCapacity: number
  readonly eventBufferCapacity: number
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
      commandQueueCapacity: 1024,
      eventBufferCapacity: 4096
    })
  }
) {}
