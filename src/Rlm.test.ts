import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Layer, Stream } from "effect"
import { complete, stream } from "./Rlm"
import { RlmConfig, type RlmConfigService } from "./RlmConfig"
import { BudgetExhaustedError } from "./RlmError"
import { RlmRuntimeLive } from "./Runtime"
import { makeFakeLanguageModelClientLayer, type FakeModelMetrics } from "./testing/FakeLanguageModelClient"
import { makeFakeSandboxFactoryLayer, type FakeSandboxMetrics } from "./testing/FakeSandboxFactory"

const defaultConfig: RlmConfigService = {
  maxIterations: 10,
  maxDepth: 1,
  maxLlmCalls: 20,
  maxTotalTokens: null,
  concurrency: 4,
  commandQueueCapacity: 1024,
  eventBufferCapacity: 4096
}

const makeLayers = (options: {
  readonly responses: ReadonlyArray<{ readonly text: string; readonly totalTokens?: number }>
  readonly modelMetrics?: FakeModelMetrics
  readonly sandboxMetrics?: FakeSandboxMetrics
  readonly config?: Partial<RlmConfigService>
}) => {
  const model = makeFakeLanguageModelClientLayer(options.responses, options.modelMetrics)
  const sandbox = makeFakeSandboxFactoryLayer(options.sandboxMetrics)
  const runtimeLayer = Layer.fresh(RlmRuntimeLive)
  const base = Layer.mergeAll(model, sandbox, runtimeLayer)
  return options.config
    ? Layer.provide(base, Layer.succeed(RlmConfig, { ...defaultConfig, ...options.config }))
    : base
}

describe("Rlm thin slice", () => {
  test("returns final answer from scripted model", async () => {
    const modelMetrics: FakeModelMetrics = { calls: 0, requests: [] }
    const sandboxMetrics: FakeSandboxMetrics = {
      createCalls: 0,
      executeCalls: 0,
      snippets: []
    }

    const answer = await Effect.runPromise(
      complete({
        query: "What is 2+2?",
        context: "2+2=4"
      }).pipe(
        Effect.either,
        Effect.provide(
          makeLayers({
            responses: [{ text: "FINAL(\"4\")", totalTokens: 12 }],
            modelMetrics,
            sandboxMetrics
          })
        )
      )
    )

    expect(answer._tag).toBe("Right")
    if (answer._tag === "Right") {
      expect(answer.right).toBe("4")
    }
    expect(modelMetrics.calls).toBe(1)
    expect(sandboxMetrics.createCalls).toBe(1)
  })

  test("reserves llm budget before model invocation", async () => {
    const modelMetrics: FakeModelMetrics = { calls: 0, requests: [] }

    const result = await Effect.runPromise(
      complete({
        query: "Will not run",
        context: "budget gate"
      }).pipe(
        Effect.either,
        Effect.provide(
          makeLayers({
            responses: [{ text: "FINAL(\"unreachable\")" }],
            modelMetrics,
            config: {
              maxIterations: 2,
              maxLlmCalls: 0
            }
          })
        )
      )
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BudgetExhaustedError)
    }
    expect(modelMetrics.calls).toBe(0)
  })

  test("emits deterministic event sequence for identical scripts", async () => {
    const runOnce = async () => {
      const events = await Effect.runPromise(
        stream({
          query: "summarize",
          context: "A B C"
        }).pipe(
          Stream.runCollect,
          Effect.provide(
            makeLayers({
              responses: [
                { text: "I will inspect first." },
                { text: "FINAL(\"done\")" }
              ]
            })
          )
        )
      )

      return Chunk.toReadonlyArray(events).map((event) => {
        switch (event._tag) {
          case "IterationStarted":
            return `${event._tag}:${event.iteration}`
          case "ModelResponse":
            return `${event._tag}:${event.text}`
          case "CallFinalized":
            return `${event._tag}:${event.answer}`
          case "CallFailed":
            return `${event._tag}:${event.error._tag}`
          default:
            return event._tag
        }
      })
    }

    const first = await runOnce()
    const second = await runOnce()

    expect(first).toEqual(second)
  })
})
