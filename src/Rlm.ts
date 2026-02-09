import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import { BridgeHandlerLive } from "./BridgeHandler"
import { RlmConfig } from "./RlmConfig"
import { RlmModel } from "./RlmModel"
import type { RlmError } from "./RlmError"
import { OutputValidationError } from "./RlmError"
import { RlmRuntime, RlmRuntimeLive } from "./Runtime"
import { CallId, RlmEvent } from "./RlmTypes"
import type { RunSchedulerOptions } from "./Scheduler"
import { runScheduler } from "./Scheduler"
import { SandboxConfig, SandboxFactory } from "./Sandbox"
import { SandboxBunLive } from "./SandboxBun"
import { renderSubmitAnswer } from "./SubmitTool"
import type { RlmToolAny } from "./RlmTool"
import { BridgeStoreLive } from "./scheduler/BridgeStore"
import { JSONSchema } from "effect"
import type { ContextMetadata } from "./ContextMetadata"

export interface CompleteOptionsBase {
  readonly query: string
  readonly context: string
  readonly contextMetadata?: ContextMetadata
  readonly depth?: number
  readonly tools?: ReadonlyArray<RlmToolAny>
}

export interface CompleteOptionsTyped<A> extends CompleteOptionsBase {
  readonly outputSchema: Schema.Schema<A, any, never>
}

export type CompleteOptions<A = string> = A extends string
  ? CompleteOptionsBase & { readonly outputSchema?: undefined }
  : CompleteOptionsTyped<A>

export interface RlmService {
  readonly stream: (options: CompleteOptionsBase) => Stream.Stream<RlmEvent, never>
  readonly complete: {
    (options: CompleteOptionsBase): Effect.Effect<string, RlmError>
    <A>(options: CompleteOptionsTyped<A>): Effect.Effect<A, RlmError>
  }
}

const toSchedulerOptions = (options: CompleteOptionsBase & { readonly outputSchema?: Schema.Schema<any, any, never> }): RunSchedulerOptions => ({
  query: options.query,
  context: options.context,
  ...(options.contextMetadata !== undefined
    ? { contextMetadata: options.contextMetadata }
    : {}),
  ...(options.depth !== undefined ? { depth: options.depth } : {}),
  ...(options.tools !== undefined && options.tools.length > 0 ? { tools: options.tools } : {}),
  ...(options.outputSchema !== undefined
    ? { outputJsonSchema: JSONSchema.make(options.outputSchema) }
    : {})
})

const streamInternal = (options: CompleteOptionsBase) =>
  Stream.unwrapScoped(
    Effect.gen(function*() {
      const runtime = yield* RlmRuntime
      const events = yield* Stream.fromPubSub(runtime.events, { scoped: true })

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

const completeInternal = Effect.fn("Rlm.complete")(function*(
  options: CompleteOptionsBase & { readonly outputSchema?: Schema.Schema<any, any, never> }
) {
  const submitted = yield* runScheduler(toSchedulerOptions(options))

  if (!options.outputSchema) {
    if (submitted.source === "answer") {
      return submitted.answer
    }
    return yield* new OutputValidationError({
      message: "Plain-text completion requires `SUBMIT({ answer: \"...\" })`.",
      raw: renderSubmitAnswer(submitted)
    })
  }

  if (submitted.source !== "value") {
    return yield* new OutputValidationError({
      message: "Structured completion requires `SUBMIT({ value: ... })`.",
      raw: renderSubmitAnswer(submitted)
    })
  }

  return yield* Schema.decodeUnknown(options.outputSchema)(submitted.value).pipe(
    Effect.mapError((e) => new OutputValidationError({
      message: `Submitted final content does not match output schema: ${String(e)}`,
      raw: renderSubmitAnswer(submitted)
    }))
  )
})

export class Rlm extends Context.Tag("@recursive-llm/Rlm")<
  Rlm,
  RlmService
>() {}

const makeRuntimeStoreLayer = () =>
  Layer.merge(
    RlmRuntimeLive,
    Layer.provide(BridgeStoreLive, RlmRuntimeLive)
  )

const makeRlmService = (makePerCallDeps: () => Layer.Layer<any, never, never>) =>
  Rlm.of({
    complete: ((options: CompleteOptionsBase & { readonly outputSchema?: Schema.Schema<any, any, never> }) =>
      completeInternal(options).pipe(Effect.provide(makePerCallDeps()))) as RlmService["complete"],
    stream: (options) =>
      streamInternal(options).pipe(Stream.provideLayer(makePerCallDeps()))
  })

export const rlmLayer: Layer.Layer<Rlm, never, RlmModel | SandboxFactory> = Layer.effect(
  Rlm,
  Effect.gen(function*() {
    const rlmModel = yield* RlmModel
    const sandboxFactory = yield* SandboxFactory
    const config = yield* RlmConfig
    const sandboxConfig = yield* SandboxConfig

    const dependencies = Layer.mergeAll(
      Layer.succeed(RlmModel, rlmModel),
      Layer.succeed(SandboxFactory, sandboxFactory),
      Layer.succeed(RlmConfig, config),
      Layer.succeed(SandboxConfig, sandboxConfig)
    )

    return makeRlmService(() => Layer.fresh(Layer.merge(makeRuntimeStoreLayer(), dependencies)))
  })
)

export const rlmBunLayer: Layer.Layer<Rlm, never, RlmModel> = Layer.effect(
  Rlm,
  Effect.gen(function*() {
    const rlmModel = yield* RlmModel
    const config = yield* RlmConfig
    const sandboxConfig = yield* SandboxConfig

    // Shared dependencies (captured at layer-build time, not per-call)
    const sharedLayers = Layer.mergeAll(
      Layer.succeed(RlmModel, rlmModel),
      Layer.succeed(RlmConfig, config),
      Layer.succeed(SandboxConfig, sandboxConfig)
    )

    // Per-call layer constructor: fresh RlmRuntime + BridgeStore → BridgeHandler → SandboxFactory
    const makePerCallDeps = () => {
      const runtimeStoreLayer = makeRuntimeStoreLayer()
      const perCallLayer = Layer.fresh(
        Layer.provideMerge(
          SandboxBunLive,
          Layer.provideMerge(BridgeHandlerLive, runtimeStoreLayer)
        )
      )
      return Layer.provideMerge(perCallLayer, sharedLayers)
    }

    return makeRlmService(makePerCallDeps)
  })
)

export const stream = streamInternal
export const complete = completeInternal
