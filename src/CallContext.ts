import { Effect, Ref, Scope } from "effect"
import type { SandboxInstance, VariableMetadata } from "./Sandbox"
import type { BridgeRequestId, CallId } from "./RlmTypes"
import { TranscriptEntry } from "./RlmTypes"
import type { RlmToolAny } from "./RlmTool"
import type { ContextMetadata } from "./ContextMetadata"

export interface VariableSnapshot {
  readonly variables: ReadonlyArray<VariableMetadata>
  readonly snapshotIteration: number
  readonly syncedAtMs: number
  readonly freshness: "fresh" | "stale"
}

export interface CallContext {
  readonly callId: CallId
  readonly depth: number
  readonly query: string
  readonly context: string
  readonly contextMetadata?: ContextMetadata
  readonly callScope: Scope.CloseableScope
  readonly sandbox: SandboxInstance
  readonly parentBridgeRequestId?: BridgeRequestId
  readonly tools?: ReadonlyArray<RlmToolAny>
  readonly outputJsonSchema?: object

  readonly iteration: Ref.Ref<number>
  readonly transcript: Ref.Ref<ReadonlyArray<TranscriptEntry>>
  readonly variableSnapshot: Ref.Ref<VariableSnapshot>
}

export interface MakeCallContextOptions {
  readonly callId: CallId
  readonly depth: number
  readonly query: string
  readonly context: string
  readonly contextMetadata?: ContextMetadata
  readonly callScope: Scope.CloseableScope
  readonly sandbox: SandboxInstance
  readonly parentBridgeRequestId?: BridgeRequestId
  readonly tools?: ReadonlyArray<RlmToolAny>
  readonly outputJsonSchema?: object
}

export const makeCallContext = (options: MakeCallContextOptions): Effect.Effect<CallContext> =>
  Effect.gen(function*() {
    const iteration = yield* Ref.make(0)
    const transcript = yield* Ref.make<ReadonlyArray<TranscriptEntry>>([])
    const variableSnapshot = yield* Ref.make<VariableSnapshot>({
      variables: [],
      snapshotIteration: 0,
      syncedAtMs: Date.now(),
      freshness: "fresh"
    })

    return {
      ...options,
      iteration,
      transcript,
      variableSnapshot
    }
  })

export const readIteration = (ctx: CallContext): Effect.Effect<number> =>
  Ref.get(ctx.iteration)

export const incrementIteration = (ctx: CallContext): Effect.Effect<number> =>
  Ref.updateAndGet(ctx.iteration, (n) => n + 1)

export const readTranscript = (ctx: CallContext): Effect.Effect<ReadonlyArray<TranscriptEntry>> =>
  Ref.get(ctx.transcript)

export const appendTranscript = (
  ctx: CallContext,
  assistantResponse: string
): Effect.Effect<void> =>
  Ref.update(ctx.transcript, (entries) => [
    ...entries,
    new TranscriptEntry({ assistantResponse })
  ])

export const attachExecutionOutput = (
  ctx: CallContext,
  output: string
): Effect.Effect<void> =>
  Ref.update(ctx.transcript, (entries) => {
    if (entries.length === 0) return entries
    const next = [...entries]
    const last = next[next.length - 1]!
    next[next.length - 1] = new TranscriptEntry({
      ...last,
      executionOutput: output
    })
    return next
  })
