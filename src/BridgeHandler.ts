import { Context, Deferred, Effect, Exit, Layer, Queue, Ref } from "effect"
import { SandboxError } from "./RlmError"
import { RlmRuntime } from "./Runtime"
import { BridgeRequestId, RlmCommand, type CallId } from "./RlmTypes"

export class BridgeHandler extends Context.Tag("@recursive-llm/BridgeHandler")<
  BridgeHandler,
  {
    readonly handle: (options: {
      readonly method: string
      readonly args: ReadonlyArray<unknown>
      readonly callerCallId: CallId
    }) => Effect.Effect<unknown, SandboxError>
  }
>() {}

export const BridgeHandlerLive: Layer.Layer<BridgeHandler, never, RlmRuntime> = Layer.effect(
  BridgeHandler,
  Effect.gen(function*() {
    const runtime = yield* RlmRuntime

    return BridgeHandler.of({
      handle: ({ method, args, callerCallId }) => {
        if (method !== "llm_query") {
          return Effect.fail(new SandboxError({ message: `Unknown bridge method: ${method}` }))
        }

        const bridgeRequestId = BridgeRequestId(crypto.randomUUID())

        return Effect.gen(function*() {
          const deferred = yield* Deferred.make<unknown, SandboxError>()
          yield* Ref.update(runtime.bridgePending, (m) => new Map([...m, [bridgeRequestId, deferred]]))

          // Route through scheduler for budget enforcement.
          // Queue.offer on shutdown interrupts (not errors), so wrap with Effect.exit.
          const offerExit = yield* Effect.exit(
            Queue.offer(runtime.commands, RlmCommand.HandleBridgeCall({
              callId: callerCallId,
              bridgeRequestId,
              method,
              args
            }))
          )
          if (Exit.isFailure(offerExit)) {
            yield* Deferred.fail(deferred, new SandboxError({ message: "Scheduler queue closed" }))
            return yield* new SandboxError({ message: "Scheduler queue closed" })
          }

          return yield* Deferred.await(deferred)
        }).pipe(
          Effect.ensuring(
            Ref.update(runtime.bridgePending, (m) => {
              const n = new Map(m)
              n.delete(bridgeRequestId)
              return n
            })
          )
        )
      }
    })
  })
)
