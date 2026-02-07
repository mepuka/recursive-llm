import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { BridgeHandlerLive } from "./BridgeHandler"
import { LanguageModelClient } from "./LanguageModelClient"
import type { RlmError } from "./RlmError"
import { RlmRuntime, RlmRuntimeLive } from "./Runtime"
import { CallId, RlmEvent } from "./RlmTypes"
import { runScheduler } from "./Scheduler"
import { SandboxFactory } from "./Sandbox"
import { SandboxBunLive } from "./SandboxBun"

export interface CompleteOptions {
  readonly query: string
  readonly context: string
  readonly depth?: number
}

export interface RlmService {
  readonly stream: (options: CompleteOptions) => Stream.Stream<RlmEvent, never>
  readonly complete: (options: CompleteOptions) => Effect.Effect<string, RlmError>
}

const toSchedulerOptions = (options: CompleteOptions) => ({
  query: options.query,
  context: options.context,
  ...(options.depth !== undefined ? { depth: options.depth } : {})
})

const streamInternal = (options: CompleteOptions) =>
  Stream.unwrapScoped(
    Effect.gen(function*() {
      const runtime = yield* RlmRuntime
      const subscription = yield* PubSub.subscribe(runtime.events)
      const events = Stream.fromQueue(subscription)

      yield* Effect.forkScoped(
        runScheduler(toSchedulerOptions(options)).pipe(
          Effect.catchAll((error) =>
            PubSub.publish(runtime.events, RlmEvent.CallFailed({
              completionId: runtime.completionId,
              callId: CallId("root"),
              depth: 0,
              error
            }))
          ),
          Effect.ensuring(PubSub.shutdown(runtime.events))
        )
      )

      return events
    })
  )

const completeInternal = Effect.fn("Rlm.complete")(function*(options: CompleteOptions) {
  return yield* runScheduler(toSchedulerOptions(options))
})

export class Rlm extends Context.Tag("@recursive-llm/Rlm")<
  Rlm,
  RlmService
>() {}

export const rlmLayer: Layer.Layer<Rlm, never, LanguageModelClient | SandboxFactory> = Layer.effect(
  Rlm,
  Effect.gen(function*() {
    const languageModelClient = yield* LanguageModelClient
    const sandboxFactory = yield* SandboxFactory

    const dependencies = Layer.mergeAll(
      Layer.succeed(LanguageModelClient, languageModelClient),
      Layer.succeed(SandboxFactory, sandboxFactory)
    )

    return Rlm.of({
      complete: (options) =>
        completeInternal(options).pipe(
          Effect.provide(Layer.provideMerge(Layer.fresh(RlmRuntimeLive), dependencies))
        ),
      stream: (options) =>
        streamInternal(options).pipe(
          Stream.provideLayer(Layer.provideMerge(Layer.fresh(RlmRuntimeLive), dependencies))
        )
    })
  })
)

export const rlmBunLayer: Layer.Layer<Rlm, never, LanguageModelClient> = Layer.effect(
  Rlm,
  Effect.gen(function*() {
    const languageModelClient = yield* LanguageModelClient

    // Shared dependency (not per-call)
    const lmcLayer = Layer.succeed(LanguageModelClient, languageModelClient)

    // Per-call layer constructor: fresh RlmRuntime → BridgeHandler → SandboxFactory
    const makePerCallDeps = () => {
      const perCallLayer = Layer.fresh(
        Layer.provideMerge(
          SandboxBunLive,
          Layer.provideMerge(BridgeHandlerLive, RlmRuntimeLive)
        )
      )
      return Layer.provideMerge(perCallLayer, lmcLayer)
    }

    return Rlm.of({
      complete: (options) =>
        completeInternal(options).pipe(Effect.provide(makePerCallDeps())),
      stream: (options) =>
        streamInternal(options).pipe(Stream.provideLayer(makePerCallDeps()))
    })
  })
)

export const stream = streamInternal
export const complete = completeInternal
