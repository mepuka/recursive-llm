import { Effect, Exit, Queue } from "effect"
import { UnknownRlmError } from "../RlmError"
import { RlmRuntime } from "../Runtime"
import type { RlmCommand } from "../RlmTypes"
import { publishSchedulerWarning } from "./Events"

export const enqueue = Effect.fnUntraced(function*(command: RlmCommand) {
  const runtime = yield* RlmRuntime
  const offerExit = yield* Effect.exit(Queue.offer(runtime.commands, command))
  if (Exit.isFailure(offerExit)) {
    return yield* new UnknownRlmError({
      message: `Scheduler queue closed while enqueueing ${command._tag}`
    })
  }

  if (!offerExit.value) {
    return yield* new UnknownRlmError({
      message: `Scheduler queue refused ${command._tag}`
    })
  }
})

export const enqueueOrWarn = Effect.fnUntraced(function*(command: RlmCommand) {
  const enqueueExit = yield* Effect.exit(enqueue(command))
  if (Exit.isFailure(enqueueExit)) {
    yield* publishSchedulerWarning({
      code: "QUEUE_CLOSED",
      message: `Dropped command ${command._tag} because scheduler queue is closed`,
      callId: command.callId,
      commandTag: command._tag
    })
    return false
  }
  return true
})
