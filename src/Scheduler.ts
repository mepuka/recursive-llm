import { Deferred, Duration, Effect, Exit, Match, Option, PubSub, Queue, Ref, Scope, Stream } from "effect"
import { consumeIteration, recordTokens, reserveLlmCall, snapshot, withLlmPermit } from "./Budget"
import { extractCodeBlock, extractFinal } from "./CodeExtractor"
import { RlmConfig } from "./RlmConfig"
import { RlmModel } from "./RlmModel"
import {
  NoFinalAnswerError,
  SandboxError,
  UnknownRlmError,
  type RlmError
} from "./RlmError"
import { buildReplPrompt, buildOneShotPrompt, truncateOutput, CONTEXT_PREVIEW_CHARS } from "./RlmPrompt"
import { buildReplSystemPrompt, buildOneShotSystemPrompt } from "./SystemPrompt"
import { SandboxFactory } from "./Sandbox"
import { RlmRuntime } from "./Runtime"
import { BridgeRequestId, CallId, CallState, RlmCommand, RlmEvent, TranscriptEntry } from "./RlmTypes"

import type { RlmToolAny } from "./RlmTool"

export interface RunSchedulerOptions {
  readonly query: string
  readonly context: string
  readonly depth?: number
  readonly rootCallId?: CallId
  readonly tools?: ReadonlyArray<RlmToolAny>
  readonly outputJsonSchema?: object
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
  const rlmModel = yield* RlmModel
  const sandboxFactory = yield* SandboxFactory

  const resultDeferred = yield* Deferred.make<string, RlmError>()

  // --- handleStartCall ---

  const handleStartCall = (command: Extract<RlmCommand, { readonly _tag: "StartCall" }>) =>
    Effect.gen(function*() {
      const callScope = yield* Scope.make()

      yield* Effect.gen(function*() {
        const toolDescriptorsForSandbox = command.tools?.map((t) => ({
          name: t.name,
          parameterNames: t.parameterNames,
          description: t.description
        }))

        const sandbox = yield* sandboxFactory.create({
          callId: command.callId,
          depth: command.depth,
          ...(toolDescriptorsForSandbox !== undefined && toolDescriptorsForSandbox.length > 0
            ? { tools: toolDescriptorsForSandbox }
            : {})
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
            : {}),
          ...(command.tools !== undefined && command.tools.length > 0
            ? { tools: command.tools }
            : {}),
          ...(command.outputJsonSchema !== undefined
            ? { outputJsonSchema: command.outputJsonSchema }
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

      const toolDescriptors = callState.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        parameterNames: t.parameterNames,
        parametersJsonSchema: t.parametersJsonSchema,
        returnsJsonSchema: t.returnsJsonSchema
      }))

      const prompt = buildReplPrompt({
        systemPrompt: buildReplSystemPrompt({
          depth: callState.depth,
          iteration: callState.iteration + 1,
          maxIterations: config.maxIterations,
          maxDepth: config.maxDepth,
          budget: {
            iterationsRemaining: budget.iterationsRemaining,
            llmCallsRemaining: budget.llmCallsRemaining
          },
          ...(toolDescriptors !== undefined && toolDescriptors.length > 0
            ? { tools: toolDescriptors }
            : {}),
          ...(callState.outputJsonSchema !== undefined
            ? { outputJsonSchema: callState.outputJsonSchema }
            : {})
        }),
        query: callState.query,
        contextLength: callState.context.length,
        contextPreview: callState.context.slice(0, CONTEXT_PREVIEW_CHARS),
        transcript: callState.transcript
      })
      const response = yield* withLlmPermit(
        rlmModel.generateText({ prompt, depth: callState.depth })
      )

      yield* recordTokens(callState.callId, response.usage.totalTokens)

      const modelEvent = RlmEvent.ModelResponse({
        completionId: runtime.completionId,
        callId: callState.callId,
        depth: callState.depth,
        text: response.text,
        usage: {
          ...(response.usage.inputTokens !== undefined
            ? { inputTokens: response.usage.inputTokens }
            : {}),
          ...(response.usage.outputTokens !== undefined
            ? { outputTokens: response.usage.outputTokens }
            : {}),
          ...(response.usage.totalTokens !== undefined
            ? { totalTokens: response.usage.totalTokens }
            : {}),
          ...(response.usage.reasoningTokens !== undefined
            ? { reasoningTokens: response.usage.reasoningTokens }
            : {}),
          ...(response.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: response.usage.cachedInputTokens }
            : {})
        }
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

      // Update last transcript entry with (truncated) execution output
      const transcript = [...callState.transcript]
      const last = transcript[transcript.length - 1]
      if (last) {
        transcript[transcript.length - 1] = new TranscriptEntry({
          ...last,
          executionOutput: truncateOutput(command.output)
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

      // Tool dispatch: non-llm_query methods route to user-defined tools
      if (command.method !== "llm_query") {
        const tool = callState.tools?.find((t) => t.name === command.method)
        if (!tool) {
          yield* failBridgeDeferred(command.bridgeRequestId, `Unknown tool: ${command.method}`)
          return
        }
        yield* Effect.forkIn(
          tool.handle(command.args).pipe(
            Effect.timeoutFail({
              duration: Duration.millis(tool.timeoutMs),
              onTimeout: () => new SandboxError({ message: `Tool ${tool.name} timed out` })
            }),
            Effect.flatMap((result) => resolveBridgeDeferred(command.bridgeRequestId, result)),
            Effect.catchAll((err) =>
              failBridgeDeferred(command.bridgeRequestId, "message" in err ? err.message : String(err))
            )
          ),
          callState.callScope
        )
        return
      }

      if (callState.depth >= config.maxDepth) {
        // At max depth: one-shot model call (no REPL protocol) with budget reservation
        yield* Effect.forkIn(
          Effect.gen(function*() {
            yield* reserveLlmCall(command.callId)
            const oneShotPrompt = buildOneShotPrompt({
              systemPrompt: buildOneShotSystemPrompt(),
              query: String(command.args[0]),
              context: String(command.args[1] ?? "")
            })
            const response = yield* withLlmPermit(
              rlmModel.generateText({ prompt: oneShotPrompt, depth: callState.depth + 1 })
            )
            yield* recordTokens(command.callId, response.usage.totalTokens)
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

  const processCommand = Match.type<RlmCommand>().pipe(
    Match.tagsExhaustive({
      StartCall: handleStartCall,
      GenerateStep: handleGenerateStep,
      ExecuteCode: handleExecuteCode,
      CodeExecuted: handleCodeExecuted,
      HandleBridgeCall: handleHandleBridgeCall,
      Finalize: handleFinalize,
      FailCall: handleFailCall
    })
  )

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

  const failRemainingBridgeDeferreds = () =>
    Effect.gen(function*() {
      const remainingBridgePending = yield* Ref.getAndSet(runtime.bridgePending, new Map())
      if (remainingBridgePending.size === 0) return

      yield* Effect.forEach([...remainingBridgePending.values()], (deferred) =>
        Deferred.fail(deferred, new SandboxError({ message: "Scheduler stopped before bridge response" })),
        { discard: true }
      )
    })

  const runLoop = Effect.gen(function*() {
    yield* enqueue(RlmCommand.StartCall({
      callId: rootCallId,
      depth: rootDepth,
      query: options.query,
      context: options.context,
      ...(options.tools !== undefined && options.tools.length > 0
        ? { tools: options.tools }
        : {}),
      ...(options.outputJsonSchema !== undefined
        ? { outputJsonSchema: options.outputJsonSchema }
        : {})
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
    Effect.onExit((exit) =>
      Effect.gen(function*() {
        yield* Queue.shutdown(runtime.commands).pipe(Effect.ignore)
        yield* failRemainingBridgeDeferreds()
        yield* closeRemainingCallScopes(exit)
      })
    )
  )
})
