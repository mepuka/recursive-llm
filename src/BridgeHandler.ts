import { Context, Deferred, Effect, Exit, Layer, Queue } from "effect"
import { SandboxError } from "./RlmError"
import { RlmRuntime } from "./Runtime"
import { BridgeRequestId, RlmCommand, type CallId } from "./RlmTypes"
import { BridgeStore } from "./scheduler/BridgeStore"

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

export const BridgeHandlerLive: Layer.Layer<BridgeHandler, never, RlmRuntime | BridgeStore> = Layer.effect(
  BridgeHandler,
  Effect.gen(function*() {
    const runtime = yield* RlmRuntime
    const bridgeStore = yield* BridgeStore

    return BridgeHandler.of({
      handle: ({ method, args, callerCallId }) => {
        const bridgeRequestId = BridgeRequestId(crypto.randomUUID())

        return Effect.gen(function*() {
          const deferred = yield* Deferred.make<unknown, SandboxError>()
          yield* bridgeStore.register(bridgeRequestId, deferred)

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
            yield* bridgeStore.fail(bridgeRequestId, new SandboxError({ message: "Scheduler queue closed" }))
            return yield* new SandboxError({ message: "Scheduler queue closed" })
          }

          return yield* Deferred.await(deferred)
        }).pipe(
          Effect.ensuring(bridgeStore.remove(bridgeRequestId).pipe(Effect.ignore))
        )
      }
    })
  })
)
