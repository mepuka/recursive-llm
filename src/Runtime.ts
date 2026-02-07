import { Context, Deferred, Effect, Layer, Option, PubSub, Queue, Ref } from "effect"
import { RlmConfig } from "./RlmConfig"
import type { SandboxError } from "./RlmError"
import { BudgetState, type BridgeRequestId, type CallId, type CallState, type RlmCommand, type RlmEvent } from "./RlmTypes"

export interface RlmRuntimeShape {
  readonly completionId: string
  readonly commands: Queue.Queue<RlmCommand>
  readonly events: PubSub.PubSub<RlmEvent>
  readonly budgetRef: Ref.Ref<BudgetState>
  readonly llmSemaphore: Effect.Semaphore
  readonly callStates: Ref.Ref<Map<CallId, CallState>>
  readonly bridgePending: Ref.Ref<Map<BridgeRequestId, Deferred.Deferred<unknown, SandboxError>>>
}

export class RlmRuntime extends Context.Tag("@recursive-llm/RlmRuntime")<
  RlmRuntime,
  RlmRuntimeShape
>() {}

export const RlmRuntimeLive = Layer.scoped(
  RlmRuntime,
  Effect.gen(function*() {
    const config = yield* RlmConfig

    const commands = yield* Effect.acquireRelease(
      Queue.bounded<RlmCommand>(config.commandQueueCapacity),
      (q) => Queue.shutdown(q)
    )
    const events = yield* Effect.acquireRelease(
      PubSub.bounded<RlmEvent>({ capacity: config.eventBufferCapacity, replay: 0 }),
      (ps) => PubSub.shutdown(ps)
    )

    const budgetRef = yield* Ref.make(new BudgetState({
      iterationsRemaining: config.maxIterations,
      llmCallsRemaining: config.maxLlmCalls,
      tokenBudgetRemaining: Option.fromNullable(config.maxTotalTokens)
    }))

    const llmSemaphore = yield* Effect.makeSemaphore(config.concurrency)
    const callStates = yield* Ref.make(new Map<CallId, CallState>())
    const bridgePending = yield* Ref.make(new Map<BridgeRequestId, Deferred.Deferred<unknown, SandboxError>>())

    const completionId = `completion-${crypto.randomUUID()}`

    return {
      completionId,
      commands,
      events,
      budgetRef,
      llmSemaphore,
      callStates,
      bridgePending
    } satisfies RlmRuntimeShape
  })
)
