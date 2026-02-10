import { Effect, PubSub } from "effect"
import { RlmRuntime } from "../Runtime"
import { RlmEvent, type CallId, type RlmCommand, type RlmEvent as RlmEventType } from "../RlmTypes"

export type SchedulerWarningCode =
  | "STALE_COMMAND_DROPPED"
  | "QUEUE_CLOSED"
  | "CALL_SCOPE_CLEANUP"
  | "MIXED_SUBMIT_AND_CODE"
  | "TOOLKIT_DEGRADED"
  | "VARIABLE_SYNC_FAILED"
  | "STALL_DETECTED_EARLY_EXTRACT"

export interface SchedulerWarning {
  readonly code: SchedulerWarningCode
  readonly message: string
  readonly callId?: CallId
  readonly commandTag?: RlmCommand["_tag"]
}

export const publishEvent = Effect.fnUntraced(function*(event: RlmEventType) {
  const runtime = yield* RlmRuntime
  yield* PubSub.publish(runtime.events, event)
})

export const publishSchedulerWarning = Effect.fnUntraced(function*(warning: SchedulerWarning) {
  const runtime = yield* RlmRuntime
  yield* PubSub.publish(runtime.events, RlmEvent.SchedulerWarning({
    completionId: runtime.completionId,
    code: warning.code,
    message: warning.message,
    ...(warning.callId !== undefined ? { callId: warning.callId } : {}),
    ...(warning.commandTag !== undefined ? { commandTag: warning.commandTag } : {})
  })).pipe(Effect.ignore)
})
