import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { RlmConfig, type RlmConfigService } from "../src/RlmConfig"
import { SandboxError } from "../src/RlmError"
import { RlmRuntime, RlmRuntimeLive } from "../src/Runtime"
import { CallId, RlmCommand } from "../src/RlmTypes"

const runtimeConfig: RlmConfigService = {
  maxIterations: 10,
  maxDepth: 1,
  maxLlmCalls: 20,
  maxTotalTokens: null,
  commandQueueCapacity: 2,
  concurrency: 4,
  enableLlmQueryBatched: true,
  maxBatchQueries: 32,
  eventBufferCapacity: 4096,
  maxExecutionOutputChars: 8_000,
  enablePromptCaching: true,
  primaryTarget: {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929"
  },
  subLlmDelegation: {
    enabled: false,
    depthThreshold: 1
  }
}

describe("RlmRuntime", () => {
  test("command queue drops offers beyond configured capacity", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* RlmRuntime

        const first = yield* Queue.offer(runtime.commands, RlmCommand.StartCall({
          callId: CallId("root"),
          depth: 0,
          query: "q",
          context: "ctx"
        }))
        const second = yield* Queue.offer(runtime.commands, RlmCommand.GenerateStep({
          callId: CallId("root")
        }))
        const third = yield* Queue.offer(runtime.commands, RlmCommand.FailCall({
          callId: CallId("root"),
          error: new SandboxError({ message: "test" })
        }))

        return [first, second, third] as const
      }).pipe(
        Effect.provide(
          Layer.provide(
            RlmRuntimeLive,
            Layer.succeed(RlmConfig, runtimeConfig)
          )
        )
      )
    )

    expect(results).toEqual([true, true, false])
  })
})
