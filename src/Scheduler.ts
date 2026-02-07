import { Deferred, Effect, Exit, Option, PubSub, Queue, Ref, Scope, Stream } from "effect"
import { consumeIteration, recordTokens, reserveLlmCall, snapshot, withLlmPermit } from "./Budget"
import { extractCodeBlock, extractFinal } from "./CodeExtractor"
import { LanguageModelClient } from "./LanguageModelClient"
import { RlmConfig } from "./RlmConfig"
import {
  NoFinalAnswerError,
  SandboxError,
  UnknownRlmError,
  type RlmError
} from "./RlmError"
import { SandboxFactory } from "./Sandbox"
import { RlmRuntime } from "./Runtime"
import { BridgeRequestId, CallId, CallState, RlmCommand, RlmEvent, TranscriptEntry } from "./RlmTypes"

export interface RunSchedulerOptions {
  readonly query: string
  readonly context: string
  readonly depth?: number
  readonly rootCallId?: CallId
}

// --- Hot-path helpers (untraced for performance) ---

const publishEvent = Effect.fnUntraced(function*(event: RlmEvent) {
  const runtime = yield* RlmRuntime
  yield* PubSub.publish(runtime.events, event)
})

const publishSchedulerWarning = Effect.fnUntraced(function*(warning: {
  readonly code: "STALE_COMMAND_DROPPED" | "QUEUE_CLOSED" | "CALL_SCOPE_CLEANUP"
  readonly message: string
  readonly callId?: CallId
  readonly commandTag?: RlmCommand["_tag"]
}) {
  const runtime = yield* RlmRuntime
  yield* PubSub.publish(runtime.events, RlmEvent.SchedulerWarning({
    completionId: runtime.completionId,
    code: warning.code,
    message: warning.message,
    ...(warning.callId !== undefined ? { callId: warning.callId } : {}),
    ...(warning.commandTag !== undefined ? { commandTag: warning.commandTag } : {})
  })).pipe(Effect.ignore)
})

const enqueue = Effect.fnUntraced(function*(command: RlmCommand) {
  const runtime = yield* RlmRuntime
  const offerExit = yield* Effect.exit(Queue.offer(runtime.commands, command))
  if (Exit.isFailure(offerExit)) {
    return yield* new UnknownRlmError({
      message: `Scheduler queue closed while enqueueing ${command._tag}`
    })
  }

  const offered = offerExit.value
  if (!offered) {
    return yield* new UnknownRlmError({
      message: `Scheduler queue refused ${command._tag}`
    })
  }
})

const enqueueOrWarn = Effect.fnUntraced(function*(command: RlmCommand) {
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

const getCallStateOption = Effect.fnUntraced(function*(callId: CallId) {
  const runtime = yield* RlmRuntime
  const states = yield* Ref.get(runtime.callStates)
  return Option.fromNullable(states.get(callId))
})

const setCallState = Effect.fnUntraced(function*(
  callId: CallId,
  state: CallState
) {
  const runtime = yield* RlmRuntime
  yield* Ref.update(runtime.callStates, (current) => {
    const next = new Map(current)
    next.set(callId, state)
    return next
  })
})

const deleteCallState = (callId: CallId) =>
  Effect.gen(function*() {
    const runtime = yield* RlmRuntime
    yield* Ref.update(runtime.callStates, (current) => {
      const next = new Map(current)
      next.delete(callId)
      return next
    })
  })

const getCallStateOrWarn = Effect.fnUntraced(function*(
  options: {
    readonly callId: CallId
    readonly commandTag: RlmCommand["_tag"]
  }
) {
  const callStateOption = yield* getCallStateOption(options.callId)
  if (Option.isNone(callStateOption)) {
    yield* publishSchedulerWarning({
      code: "STALE_COMMAND_DROPPED",
      message: `Dropped stale command ${options.commandTag} for inactive call ${options.callId}`,
      callId: options.callId,
      commandTag: options.commandTag
    })
    return Option.none<CallState>()
  }
  return callStateOption
})

// --- Bridge deferred helpers ---

const resolveBridgeDeferred = (bridgeRequestId: BridgeRequestId, value: unknown) =>
  Effect.gen(function*() {
    const runtime = yield* RlmRuntime
    const pending = yield* Ref.get(runtime.bridgePending)
    const deferred = pending.get(bridgeRequestId)
    if (deferred) yield* Deferred.succeed(deferred, value)
  })

const failBridgeDeferred = (bridgeRequestId: BridgeRequestId, error: unknown) =>
  Effect.gen(function*() {
    const runtime = yield* RlmRuntime
    const pending = yield* Ref.get(runtime.bridgePending)
    const deferred = pending.get(bridgeRequestId)
    if (deferred) yield* Deferred.fail(deferred, new SandboxError({ message: String(error) }))
  })

// --- Scheduler ---

export const runScheduler = Effect.fn("Scheduler.run")(function*(options: RunSchedulerOptions) {
  const runtime = yield* RlmRuntime
  const rootCallId = options.rootCallId ?? CallId("root")
  const rootDepth = options.depth ?? 0

  const config = yield* RlmConfig
  const model = yield* LanguageModelClient
  const sandboxFactory = yield* SandboxFactory

  const resultDeferred = yield* Deferred.make<string, RlmError>()

  // --- handleStartCall ---

  const handleStartCall = (command: Extract<RlmCommand, { readonly _tag: "StartCall" }>) =>
    Effect.gen(function*() {
      const callScope = yield* Scope.make()

      yield* Effect.gen(function*() {
        const sandbox = yield* sandboxFactory.create({
          callId: command.callId,
          depth: command.depth
        }).pipe(Effect.provideService(Scope.Scope, callScope))

        yield* sandbox.setVariable("context", command.context)
        yield* sandbox.setVariable("query", command.query)

        const state = new CallState({
          callId: command.callId,
          depth: command.depth,
          query: command.query,
          context: command.context,
          iteration: 0,
          transcript: [],
          sandbox,
          callScope,
          ...(command.parentBridgeRequestId !== undefined
            ? { parentBridgeRequestId: command.parentBridgeRequestId }
            : {})
        })

        yield* setCallState(command.callId, state)

        yield* publishEvent(RlmEvent.CallStarted({
          completionId: runtime.completionId,
          callId: command.callId,
          depth: command.depth
        }))

        yield* enqueueOrWarn(RlmCommand.GenerateStep({
          callId: command.callId
        }))
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            // Close scope directly — CallState was never stored so handleFailCall can't.
            // Use Effect.exit to prevent finalizer failures from masking the original error.
            yield* Effect.exit(Scope.close(callScope, Exit.fail(error)))

            if (command.parentBridgeRequestId) {
              yield* failBridgeDeferred(command.parentBridgeRequestId, error)
            }
            yield* enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: new UnknownRlmError({ message: "StartCall failed", cause: error })
            }))
          })
        )
      )
    })

  // --- handleGenerateStep ---

  const handleGenerateStep = (command: Extract<RlmCommand, { readonly _tag: "GenerateStep" }>) =>
    Effect.gen(function*() {
      const callStateOption = yield* getCallStateOrWarn({
        callId: command.callId,
        commandTag: command._tag
      })
      if (Option.isNone(callStateOption)) return
      const callState = callStateOption.value

      yield* consumeIteration(callState.callId)

      const budget = yield* snapshot
      yield* publishEvent(RlmEvent.IterationStarted({
        completionId: runtime.completionId,
        callId: callState.callId,
        depth: callState.depth,
        iteration: callState.iteration + 1,
        budget
      }))

      yield* reserveLlmCall(callState.callId)

      const response = yield* withLlmPermit(
        model.generate({
          query: callState.query,
          context: callState.context,
          depth: callState.depth,
          iteration: callState.iteration + 1,
          transcript: callState.transcript.map((entry) =>
            entry.executionOutput
              ? `${entry.assistantResponse}\n\n[Execution Output]\n${entry.executionOutput}`
              : entry.assistantResponse
          )
        })
      )

      yield* recordTokens(callState.callId, response.totalTokens)

      const modelEvent = response.totalTokens === undefined
        ? RlmEvent.ModelResponse({
          completionId: runtime.completionId,
          callId: callState.callId,
          depth: callState.depth,
          text: response.text
        })
        : RlmEvent.ModelResponse({
          completionId: runtime.completionId,
          callId: callState.callId,
          depth: callState.depth,
          text: response.text,
          usage: { totalTokens: response.totalTokens }
        })

      yield* publishEvent(modelEvent)

      // Check for FINAL answer
      const finalAnswer = extractFinal(response.text)
      if (finalAnswer !== null) {
        yield* enqueueOrWarn(RlmCommand.Finalize({
          callId: callState.callId,
          answer: finalAnswer
        }))
        return
      }

      // Add model response to transcript
      const nextState = new CallState({
        ...callState,
        iteration: callState.iteration + 1,
        transcript: [...callState.transcript, new TranscriptEntry({ assistantResponse: response.text })]
      })

      yield* setCallState(callState.callId, nextState)

      // Extract code block → execute or continue
      const code = extractCodeBlock(response.text)
      if (code !== null) {
        yield* enqueueOrWarn(RlmCommand.ExecuteCode({ callId: callState.callId, code }))
      } else {
        yield* enqueueOrWarn(RlmCommand.GenerateStep({ callId: callState.callId }))
      }
    }).pipe(
      Effect.catchTag("BudgetExhaustedError", (err) =>
        enqueueOrWarn(RlmCommand.FailCall({
          callId: command.callId,
          error: err.resource === "iterations"
            ? new NoFinalAnswerError({ callId: command.callId, maxIterations: config.maxIterations })
            : err
        }))
      ),
      Effect.catchAll((error) =>
        enqueueOrWarn(RlmCommand.FailCall({
          callId: command.callId,
          error: new UnknownRlmError({ message: "GenerateStep failed", cause: error })
        }))
      )
    )

  // --- handleExecuteCode ---

  const handleExecuteCode = (command: Extract<RlmCommand, { readonly _tag: "ExecuteCode" }>) =>
    Effect.gen(function*() {
      const callStateOption = yield* getCallStateOrWarn({
        callId: command.callId,
        commandTag: command._tag
      })
      if (Option.isNone(callStateOption)) return
      const callState = callStateOption.value

      yield* publishEvent(RlmEvent.CodeExecutionStarted({
        completionId: runtime.completionId,
        callId: command.callId,
        depth: callState.depth,
        code: command.code
      }))

      // Fork into call scope so fiber is interrupted when call scope closes
      yield* Effect.forkIn(
        callState.sandbox.execute(command.code).pipe(
          Effect.flatMap((output) =>
            enqueueOrWarn(RlmCommand.CodeExecuted({ callId: command.callId, output }))
          ),
          Effect.catchAll((error) =>
            enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: new SandboxError({ message: `Code execution failed: ${error.message}` })
            }))
          )
        ),
        callState.callScope
      )
    })

  // --- handleCodeExecuted ---

  const handleCodeExecuted = (command: Extract<RlmCommand, { readonly _tag: "CodeExecuted" }>) =>
    Effect.gen(function*() {
      const callStateOption = yield* getCallStateOrWarn({
        callId: command.callId,
        commandTag: command._tag
      })
      if (Option.isNone(callStateOption)) return
      const callState = callStateOption.value

      yield* publishEvent(RlmEvent.CodeExecutionCompleted({
        completionId: runtime.completionId,
        callId: command.callId,
        depth: callState.depth,
        output: command.output
      }))

      // Update last transcript entry with execution output
      const transcript = [...callState.transcript]
      const last = transcript[transcript.length - 1]
      if (last) {
        transcript[transcript.length - 1] = new TranscriptEntry({
          ...last,
          executionOutput: command.output
        })
      }

      yield* setCallState(command.callId, new CallState({ ...callState, transcript }))
      yield* enqueueOrWarn(RlmCommand.GenerateStep({ callId: command.callId }))
    })

  // --- handleHandleBridgeCall ---

  const handleHandleBridgeCall = (command: Extract<RlmCommand, { readonly _tag: "HandleBridgeCall" }>) =>
    Effect.gen(function*() {
      // Guard: call state may be deleted if call already finalized
      const states = yield* Ref.get(runtime.callStates)
      const callState = states.get(command.callId)
      if (!callState) {
        yield* publishSchedulerWarning({
          code: "STALE_COMMAND_DROPPED",
          message: `Dropped stale command ${command._tag} for inactive call ${command.callId}`,
          callId: command.callId,
          commandTag: command._tag
        })
        yield* failBridgeDeferred(command.bridgeRequestId, "Call no longer active")
        return
      }

      yield* publishEvent(RlmEvent.BridgeCallReceived({
        completionId: runtime.completionId,
        callId: command.callId,
        depth: callState.depth,
        method: command.method
      }))

      if (callState.depth >= config.maxDepth) {
        // At max depth: direct model call with budget reservation
        yield* Effect.forkIn(
          Effect.gen(function*() {
            yield* reserveLlmCall(command.callId)
            const response = yield* withLlmPermit(
              model.generate({
                query: String(command.args[0]),
                context: String(command.args[1] ?? ""),
                depth: callState.depth + 1,
                iteration: 1,
                transcript: []
              })
            )
            yield* recordTokens(command.callId, response.totalTokens)
            yield* resolveBridgeDeferred(command.bridgeRequestId, response.text)
          }).pipe(
            Effect.catchAll((error) =>
              failBridgeDeferred(command.bridgeRequestId, error)
            )
          ),
          callState.callScope
        )
      } else {
        // Below max depth: start recursive sub-call through scheduler
        const subCallId = CallId(`${command.callId}-bridge-${command.bridgeRequestId}`)
        const enqueueExit = yield* Effect.exit(
          enqueue(RlmCommand.StartCall({
            callId: subCallId,
            depth: callState.depth + 1,
            query: String(command.args[0]),
            context: String(command.args[1] ?? ""),
            parentBridgeRequestId: command.bridgeRequestId
          }))
        )
        if (Exit.isFailure(enqueueExit)) {
          yield* failBridgeDeferred(command.bridgeRequestId, "Scheduler shutting down")
        }
      }
    })

  // --- handleFinalize ---

  const handleFinalize = (command: Extract<RlmCommand, { readonly _tag: "Finalize" }>) =>
    Effect.gen(function*() {
      const callStateOption = yield* getCallStateOrWarn({
        callId: command.callId,
        commandTag: command._tag
      })
      if (Option.isNone(callStateOption)) return
      const callState = callStateOption.value

      yield* publishEvent(RlmEvent.CallFinalized({
        completionId: runtime.completionId,
        callId: command.callId,
        depth: callState.depth,
        answer: command.answer
      }))

      yield* Scope.close(callState.callScope, Exit.void)
      yield* deleteCallState(command.callId)

      if (callState.parentBridgeRequestId) {
        // Sub-call completing → resolve bridge deferred
        yield* resolveBridgeDeferred(callState.parentBridgeRequestId, command.answer)
      } else if (command.callId === rootCallId) {
        // Fail all outstanding bridge deferreds before queue shutdown
        const bridgePending = yield* Ref.getAndSet(runtime.bridgePending, new Map())
        yield* Effect.forEach([...bridgePending.values()], (d) =>
          Deferred.fail(d, new SandboxError({ message: "RLM completion finished" })),
          { discard: true }
        )
        yield* Deferred.succeed(resultDeferred, command.answer)
        yield* Queue.shutdown(runtime.commands)
      }
    })

  // --- handleFailCall ---

  const handleFailCall = (command: Extract<RlmCommand, { readonly _tag: "FailCall" }>) =>
    Effect.gen(function*() {
      const states = yield* Ref.get(runtime.callStates)
      const callState = states.get(command.callId)
      const depth = callState?.depth ?? 0

      yield* publishEvent(RlmEvent.CallFailed({
        completionId: runtime.completionId,
        callId: command.callId,
        depth,
        error: command.error
      }))

      if (callState) {
        yield* Scope.close(callState.callScope, Exit.fail(command.error))
      }
      yield* deleteCallState(command.callId)

      if (callState?.parentBridgeRequestId) {
        yield* failBridgeDeferred(callState.parentBridgeRequestId, command.error)
      } else if (command.callId === rootCallId) {
        // Fail all outstanding bridge deferreds before queue shutdown
        const bridgePending = yield* Ref.getAndSet(runtime.bridgePending, new Map())
        yield* Effect.forEach([...bridgePending.values()], (d) =>
          Deferred.fail(d, new SandboxError({ message: "RLM completion failed" })),
          { discard: true }
        )
        yield* Deferred.fail(resultDeferred, command.error)
        yield* Queue.shutdown(runtime.commands)
      }
    })

  // --- Command dispatch ---

  const processCommand = (command: RlmCommand) => {
    switch (command._tag) {
      case "StartCall":
        return handleStartCall(command)
      case "GenerateStep":
        return handleGenerateStep(command)
      case "ExecuteCode":
        return handleExecuteCode(command)
      case "CodeExecuted":
        return handleCodeExecuted(command)
      case "HandleBridgeCall":
        return handleHandleBridgeCall(command)
      case "Finalize":
        return handleFinalize(command)
      case "FailCall":
        return handleFailCall(command)
    }
  }

  const closeRemainingCallScopes = (exit: Exit.Exit<unknown, unknown>) =>
    Effect.gen(function*() {
      const remainingStates = yield* Ref.getAndSet(runtime.callStates, new Map())
      if (remainingStates.size === 0) return

      yield* Effect.forEach([...remainingStates.values()], (state) =>
        Effect.gen(function*() {
          yield* publishSchedulerWarning({
            code: "CALL_SCOPE_CLEANUP",
            message: `Closing leaked call scope for ${state.callId} during scheduler shutdown`,
            callId: state.callId
          })
          yield* Scope.close(state.callScope, exit).pipe(Effect.ignore)
        }),
        { discard: true }
      )
    })

  const runLoop = Effect.gen(function*() {
    yield* enqueue(RlmCommand.StartCall({
      callId: rootCallId,
      depth: rootDepth,
      query: options.query,
      context: options.context
    }))

    // Stream.fromQueue terminates cleanly when Queue.shutdown is called
    yield* Stream.fromQueue(runtime.commands).pipe(
      Stream.runForEach((command) =>
        processCommand(command).pipe(
          Effect.catchAllCause((cause) =>
            enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: new UnknownRlmError({ message: "Unexpected scheduler failure", cause })
            }))
          )
        )
      )
    )

    return yield* Deferred.await(resultDeferred)
  })

  return yield* runLoop.pipe(
    Effect.onExit((exit) => closeRemainingCallScopes(exit))
  )
})
