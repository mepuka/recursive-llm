import { Deferred, Duration, Effect, Exit, Match, Option, PubSub, Queue, Ref, Schedule, Scope, Stream } from "effect"
import { consumeIteration, recordTokens, reserveLlmCall, snapshot, withLlmPermit } from "./Budget"
import {
  appendTranscript,
  attachExecutionOutput,
  incrementIteration,
  makeCallContext,
  readIteration,
  readTranscript,
  type CallContext
} from "./CallContext"
import { extractCodeBlock, extractFinal } from "./CodeExtractor"
import { RlmConfig } from "./RlmConfig"
import { RlmModel } from "./RlmModel"
import {
  BudgetExhaustedError,
  NoFinalAnswerError,
  SandboxError,
  UnknownRlmError,
  type RlmError
} from "./RlmError"
import {
  buildReplPrompt,
  buildOneShotPrompt,
  buildExtractPrompt,
  truncateExecutionOutput,
  CONTEXT_PREVIEW_CHARS
} from "./RlmPrompt"
import { buildReplSystemPrompt, buildOneShotSystemPrompt, buildExtractSystemPrompt } from "./SystemPrompt"
import { extractSubmitAnswer, SUBMIT_TOOL_NAME, submitToolkit } from "./SubmitTool"
import { SandboxConfig, SandboxFactory } from "./Sandbox"
import { RlmRuntime } from "./Runtime"
import { BridgeRequestId, CallId, RlmCommand, RlmEvent } from "./RlmTypes"
import { makeCallVariableSpace } from "./VariableSpace"

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
  readonly code:
    | "STALE_COMMAND_DROPPED"
    | "QUEUE_CLOSED"
    | "CALL_SCOPE_CLEANUP"
    | "MIXED_SUBMIT_AND_CODE"
    | "TOOLKIT_DEGRADED"
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
  state: CallContext
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
    return Option.none<CallContext>()
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

const formatExecutionError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message
    return typeof message === "string" ? message : String(message)
  }
  return String(error)
}

// --- Scheduler ---

export const runScheduler = Effect.fn("Scheduler.run")(function*(options: RunSchedulerOptions) {
  const runtime = yield* RlmRuntime
  const rootCallId = options.rootCallId ?? CallId("root")
  const rootDepth = options.depth ?? 0

  const config = yield* RlmConfig
  const rlmModel = yield* RlmModel
  const sandboxFactory = yield* SandboxFactory
  const sandboxConfig = yield* SandboxConfig
  const bridgeRetryBaseDelayMs = config.bridgeRetryBaseDelayMs ?? 50
  const bridgeToolRetryCount = config.bridgeToolRetryCount ?? 1
  const bridgeLlmQueryRetryCount = config.bridgeLlmQueryRetryCount ?? 1

  const bridgeToolRetryPolicy = Schedule.exponential(Duration.millis(bridgeRetryBaseDelayMs)).pipe(
    Schedule.compose(Schedule.recurs(bridgeToolRetryCount))
  )

  const bridgeLlmQueryRetryPolicy = Schedule.exponential(Duration.millis(bridgeRetryBaseDelayMs)).pipe(
    Schedule.compose(Schedule.recurs(bridgeLlmQueryRetryCount))
  )

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

        const state = yield* makeCallContext({
          callId: command.callId,
          depth: command.depth,
          query: command.query,
          context: command.context,
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

        const vars = makeCallVariableSpace(state)
        yield* vars.injectAll({
          context: command.context,
          query: command.query
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
      const iteration = yield* readIteration(callState)
      const transcript = yield* readTranscript(callState)

      // Per-call iteration enforcement: each call gets its own maxIterations budget
      if (iteration >= config.maxIterations) {
        return yield* new BudgetExhaustedError({
          resource: "iterations",
          callId: callState.callId,
          remaining: 0
        })
      }

      yield* consumeIteration(callState.callId)

      const budget = yield* snapshot
      yield* publishEvent(RlmEvent.IterationStarted({
        completionId: runtime.completionId,
        callId: callState.callId,
        depth: callState.depth,
        iteration: iteration + 1,
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
          iteration: iteration + 1,
          maxIterations: config.maxIterations,
          maxDepth: config.maxDepth,
          budget: {
            iterationsRemaining: config.maxIterations - (iteration + 1),
            llmCallsRemaining: budget.llmCallsRemaining
          },
          ...(toolDescriptors !== undefined && toolDescriptors.length > 0
            ? { tools: toolDescriptors }
            : {}),
          ...(callState.outputJsonSchema !== undefined
            ? { outputJsonSchema: callState.outputJsonSchema }
            : {}),
          sandboxMode: sandboxConfig.sandboxMode,
          ...(config.subModelContextChars !== undefined
            ? { subModelContextChars: config.subModelContextChars }
            : {})
        }),
        query: callState.query,
        contextLength: callState.context.length,
        contextPreview: callState.context.slice(0, CONTEXT_PREVIEW_CHARS),
        transcript
      })
      const response = yield* withLlmPermit(
        rlmModel.generateText({
          prompt,
          depth: callState.depth,
          toolkit: submitToolkit,
          toolChoice: "auto",
          disableToolCallResolution: true
        })
      ).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* publishSchedulerWarning({
              code: "TOOLKIT_DEGRADED",
              message: `Tool-enabled generation failed; retrying this iteration without tool calling (${formatExecutionError(error)})`,
              callId: callState.callId,
              commandTag: command._tag
            })

            // Fallback call consumes another LLM budget slot.
            yield* reserveLlmCall(callState.callId)

            return yield* withLlmPermit(
              rlmModel.generateText({
                prompt,
                depth: callState.depth,
                toolChoice: "none"
              })
            )
          })
        )
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

      // Structured SUBMIT tool-call is the primary finalization path.
      const submitAnswer = extractSubmitAnswer(response)
      const code = extractCodeBlock(response.text)
      if (submitAnswer !== undefined) {
        if (code !== null) {
          yield* publishSchedulerWarning({
            code: "MIXED_SUBMIT_AND_CODE",
            message: "Model returned both SUBMIT and executable code; prioritizing SUBMIT and ignoring code block",
            callId: callState.callId,
            commandTag: command._tag
          })
        }
        yield* enqueueOrWarn(RlmCommand.Finalize({
          callId: callState.callId,
          answer: submitAnswer.answer
        }))
        return
      }

      // No SUBMIT — code block takes priority over legacy FINAL().
      if (code !== null) {
        yield* appendTranscript(callState, response.text)
        yield* incrementIteration(callState)
        yield* enqueueOrWarn(RlmCommand.ExecuteCode({ callId: callState.callId, code }))
        return
      }

      // No code block — check for legacy FINAL answer
      const finalAnswer = extractFinal(response.text)
      if (finalAnswer !== null) {
        yield* enqueueOrWarn(RlmCommand.Finalize({
          callId: callState.callId,
          answer: finalAnswer
        }))
        return
      }

      // Neither SUBMIT, code block, nor FINAL — add to transcript and loop
      yield* appendTranscript(callState, response.text)
      yield* incrementIteration(callState)
      yield* enqueueOrWarn(RlmCommand.GenerateStep({ callId: callState.callId }))
    }).pipe(
      Effect.catchTag("BudgetExhaustedError", (err) =>
        Effect.gen(function*() {
          // Non-iteration budget exhaustion → hard fail as before
          if (err.resource !== "iterations") {
            return yield* enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: err
            }))
          }

          // Get call state — need transcript for extract prompt
          const callStateOption = yield* getCallStateOption(command.callId)
          if (Option.isNone(callStateOption)) {
            return yield* enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: new NoFinalAnswerError({ callId: command.callId, maxIterations: config.maxIterations })
            }))
          }
          const callState = callStateOption.value

          // Attempt extract: reserve LLM call budget (if exhausted, hard fail)
          const reserveExit = yield* Effect.exit(reserveLlmCall(callState.callId))
          if (Exit.isFailure(reserveExit)) {
            return yield* enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: new NoFinalAnswerError({ callId: command.callId, maxIterations: config.maxIterations })
            }))
          }

          const transcript = yield* readTranscript(callState)

          // Build extract prompt with full transcript
          const extractPrompt = buildExtractPrompt({
            systemPrompt: buildExtractSystemPrompt(callState.outputJsonSchema),
            query: callState.query,
            contextLength: callState.context.length,
            contextPreview: callState.context.slice(0, CONTEXT_PREVIEW_CHARS),
            transcript
          })

          const response = yield* withLlmPermit(
            rlmModel.generateText({
              prompt: extractPrompt,
              depth: callState.depth,
              toolkit: submitToolkit,
              toolChoice: { tool: SUBMIT_TOOL_NAME },
              disableToolCallResolution: true
            })
          ).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function*() {
                yield* publishSchedulerWarning({
                  code: "TOOLKIT_DEGRADED",
                  message: `Tool-enabled extract failed; retrying extract without tool calling (${formatExecutionError(error)})`,
                  callId: callState.callId,
                  commandTag: command._tag
                })

                // Fallback extract consumes another LLM budget slot.
                yield* reserveLlmCall(callState.callId)

                return yield* withLlmPermit(
                  rlmModel.generateText({
                    prompt: extractPrompt,
                    depth: callState.depth,
                    toolChoice: "none"
                  })
                )
              })
            )
          )
          yield* recordTokens(callState.callId, response.usage.totalTokens)

          // Publish model response event for observability
          yield* publishEvent(RlmEvent.ModelResponse({
            completionId: runtime.completionId,
            callId: callState.callId,
            depth: callState.depth,
            text: response.text,
            usage: {
              ...(response.usage.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
              ...(response.usage.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
              ...(response.usage.totalTokens !== undefined ? { totalTokens: response.usage.totalTokens } : {})
            }
          }))

          const submitAnswer = extractSubmitAnswer(response)
          if (submitAnswer !== undefined) {
            yield* enqueueOrWarn(RlmCommand.Finalize({
              callId: callState.callId,
              answer: submitAnswer.answer
            }))
            return
          }

          // Try extracting FINAL from response
          const finalAnswer = extractFinal(response.text)
          if (finalAnswer !== null) {
            yield* enqueueOrWarn(RlmCommand.Finalize({ callId: callState.callId, answer: finalAnswer }))
          } else {
            // Extract didn't produce FINAL() — strip code blocks and use
            // the best available content as the answer
            const stripped = response.text.replace(/```[\s\S]*?```/g, "").trim()
            const lastOutput = transcript.length > 0
              ? transcript[transcript.length - 1]!.executionOutput?.trim()
              : undefined
            // Prefer last execution output when it has real data and stripped
            // text is just short commentary (the model continued generating
            // code instead of answering)
            const preferOutput = lastOutput && lastOutput.length > 0
              && (stripped.length === 0 || (lastOutput.length > stripped.length * 2))
            const answer = preferOutput
              ? lastOutput!
              : (stripped.length > 0 ? stripped : response.text)
            yield* enqueueOrWarn(RlmCommand.Finalize({ callId: callState.callId, answer }))
          }
        }).pipe(
          // If the extract call itself fails, fall back to NoFinalAnswerError
          Effect.catchAll(() =>
            enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: new NoFinalAnswerError({ callId: command.callId, maxIterations: config.maxIterations })
            }))
          )
        )
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
            enqueueOrWarn(RlmCommand.CodeExecuted({
              callId: command.callId,
              output: `Error: ${formatExecutionError(error)}`
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

      yield* attachExecutionOutput(
        callState,
        truncateExecutionOutput(command.output, config.maxExecutionOutputChars)
      )

      const vars = makeCallVariableSpace(callState)
      yield* vars.sync.pipe(
        Effect.catchAll(() => Effect.void)
      )

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
            Effect.retry(bridgeToolRetryPolicy),
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
            const oneShotPrompt = buildOneShotPrompt({
              systemPrompt: buildOneShotSystemPrompt(),
              query: String(command.args[0]),
              context: String(command.args[1] ?? "")
            })

            const oneShotResponseText = yield* Effect.gen(function*() {
              yield* reserveLlmCall(command.callId)
              const response = yield* withLlmPermit(
                rlmModel.generateText({ prompt: oneShotPrompt, depth: callState.depth + 1 })
              )
              yield* recordTokens(command.callId, response.usage.totalTokens)
              return response.text
            }).pipe(
              Effect.retry(bridgeLlmQueryRetryPolicy)
            )

            yield* resolveBridgeDeferred(command.bridgeRequestId, oneShotResponseText)
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
