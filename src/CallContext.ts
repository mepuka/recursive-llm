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
  readonly consecutiveStalls: Ref.Ref<number>
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
      syncedAtMs: Date.now()
    })
    const consecutiveStalls = yield* Ref.make(0)

    return {
      ...options,
      iteration,
      transcript,
      variableSnapshot,
      consecutiveStalls
    }
  })

export const readIteration = (ctx: CallContext): Effect.Effect<number> =>
  Ref.get(ctx.iteration)

export const incrementIteration = (ctx: CallContext): Effect.Effect<number> =>
  Ref.updateAndGet(ctx.iteration, (n) => n + 1)

export const readTranscript = (ctx: CallContext): Effect.Effect<ReadonlyArray<TranscriptEntry>> =>
  Ref.get(ctx.transcript)

export const readConsecutiveStalls = (ctx: CallContext): Effect.Effect<number> =>
  Ref.get(ctx.consecutiveStalls)

export const resetConsecutiveStalls = (ctx: CallContext): Effect.Effect<void> =>
  Ref.set(ctx.consecutiveStalls, 0)

export const incrementConsecutiveStalls = (ctx: CallContext): Effect.Effect<number> =>
  Ref.updateAndGet(ctx.consecutiveStalls, (n) => n + 1)

export const appendTranscript = (
  ctx: CallContext,
  assistantResponse: string
): Effect.Effect<void> => {
  const trimmed = assistantResponse.trim()
  if (trimmed === "") return Effect.void
  return Ref.update(ctx.transcript, (entries) => [
    ...entries,
    new TranscriptEntry({ assistantResponse: trimmed })
  ])
}

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
