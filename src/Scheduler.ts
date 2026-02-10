import { Cause, Deferred, Duration, Effect, Exit, Match, Option, Queue, Ref, Schedule, Scope, Stream } from "effect"
import { consumeIteration, recordTokens, reserveLlmCall, snapshot, withLlmPermit } from "./Budget"
import {
  appendTranscript,
  attachExecutionOutput,
  hasCodeExecuted,
  incrementConsecutiveStalls,
  incrementIteration,
  makeCallContext,
  markCodeExecuted,
  readIteration,
  readTranscript,
  resetConsecutiveStalls
} from "./CallContext"
import type { CallContext } from "./CallContext"
import { extractCodeBlock } from "./CodeExtractor"
import { RlmConfig } from "./RlmConfig"
import { RlmModel } from "./RlmModel"
import {
  BudgetExhaustedError,
  NoFinalAnswerError,
  OutputValidationError,
  SandboxError,
  UnknownRlmError,
  type RlmError
} from "./RlmError"
import {
  buildReplPrompt,
  buildOneShotPrompt,
  buildExtractPrompt,
  truncateExecutionOutput
} from "./RlmPrompt"
import { buildReplSystemPrompt, buildOneShotSystemPrompt, buildExtractSystemPrompt } from "./SystemPrompt"
import {
  buildSubmitToolkit,
  extractSubmitAnswer,
  renderSubmitAnswer,
  SUBMIT_TOOL_NAME,
  type SubmitPayload
} from "./SubmitTool"
import { SandboxConfig, SandboxFactory } from "./Sandbox"
import { RlmRuntime } from "./Runtime"
import { BridgeRequestId, CallId, type FinalAnswerPayload, RlmCommand, RlmEvent } from "./RlmTypes"
import { RunTraceWriter } from "./RunTraceWriter"
import { makeCallVariableSpace } from "./VariableSpace"
import { getCallStateOption, getCallStateOrWarn, deleteCallState, setCallState } from "./scheduler/CallStateStore"
import { BridgeStore } from "./scheduler/BridgeStore"
import { publishEvent, publishSchedulerWarning } from "./scheduler/Events"
import { enqueue, enqueueOrWarn } from "./scheduler/Queue"
import { analyzeContext, type ContextMetadata } from "./ContextMetadata"

import type { RlmToolAny } from "./RlmTool"

export interface RunSchedulerOptions {
  readonly query: string
  readonly context: string
  readonly contextMetadata?: ContextMetadata
  readonly depth?: number
  readonly rootCallId?: CallId
  readonly tools?: ReadonlyArray<RlmToolAny>
  readonly outputJsonSchema?: object
}

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
  const bridgeStore = yield* BridgeStore
  const traceWriter = yield* RunTraceWriter
  const bridgeRetryBaseDelayMs = config.bridgeRetryBaseDelayMs ?? 50
  const bridgeToolRetryCount = config.bridgeToolRetryCount ?? 1
  const bridgeLlmQueryRetryCount = config.bridgeLlmQueryRetryCount ?? 1

  const bridgeToolRetryPolicy = Schedule.exponential(Duration.millis(bridgeRetryBaseDelayMs)).pipe(
    Schedule.compose(Schedule.recurs(bridgeToolRetryCount))
  )

  const bridgeLlmQueryRetryPolicy = Schedule.exponential(Duration.millis(bridgeRetryBaseDelayMs)).pipe(
    Schedule.compose(Schedule.recurs(bridgeLlmQueryRetryCount))
  )
  const stallConsecutiveLimit = Math.max(1, config.stallConsecutiveLimit ?? 3)
  const stallResponseMaxChars = Math.max(0, config.stallResponseMaxChars ?? 24)

  const resultDeferred = yield* Deferred.make<FinalAnswerPayload, RlmError>()

  const resolveBridgeDeferred = (bridgeRequestId: BridgeRequestId, value: unknown) =>
    bridgeStore.resolve(bridgeRequestId, value).pipe(Effect.asVoid)

  const failBridgeDeferred = (bridgeRequestId: BridgeRequestId, error: unknown) =>
    bridgeStore.fail(bridgeRequestId, error).pipe(Effect.asVoid)

  const deriveContextMetadata = (command: Extract<RlmCommand, { readonly _tag: "StartCall" }>): ContextMetadata | undefined => {
    if (command.callId === rootCallId) {
      if (options.contextMetadata !== undefined) return options.contextMetadata
      return command.context.length > 0
        ? analyzeContext(command.context)
        : undefined
    }

    return command.context.length > 0
      ? analyzeContext(command.context)
      : undefined
  }

  const resolveSubmitPayload = (
    callState: CallContext,
    payload: SubmitPayload,
    rawResponse: string
  ): Effect.Effect<FinalAnswerPayload, OutputValidationError> => {
    if (payload.source !== "variable") {
      return Effect.succeed(payload)
    }

    return Effect.gen(function*() {
      const resolvedValue = yield* callState.sandbox.getVariable(payload.variable).pipe(
        Effect.mapError((error) =>
          new OutputValidationError({
            message: `Failed to read SUBMIT variable "${payload.variable}": ${error.message}`,
            raw: rawResponse
          })
        )
      )

      if (resolvedValue === undefined) {
        return yield* new OutputValidationError({
          message: `SUBMIT variable "${payload.variable}" was not found in __vars.`,
          raw: rawResponse
        })
      }

      if (callState.outputJsonSchema !== undefined) {
        return {
          source: "value",
          value: resolvedValue
        } satisfies FinalAnswerPayload
      }

      if (typeof resolvedValue !== "string") {
        return yield* new OutputValidationError({
          message: `SUBMIT variable "${payload.variable}" must resolve to a string in plain-output mode.`,
          raw: rawResponse
        })
      }

      return {
        source: "answer",
        answer: resolvedValue
      } satisfies FinalAnswerPayload
    })
  }

  // --- handleStartCall ---

  const handleStartCall = (command: Extract<RlmCommand, { readonly _tag: "StartCall" }>) =>
    Effect.gen(function*() {
      const callScope = yield* Scope.make()

      yield* Effect.gen(function*() {
        const isStrict = sandboxConfig.sandboxMode === "strict"
        const toolDescriptorsForSandbox = isStrict
          ? undefined
          : command.tools?.map((t) => ({
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

        const contextMetadata = deriveContextMetadata(command)

        const state = yield* makeCallContext({
          callId: command.callId,
          depth: command.depth,
          query: command.query,
          context: command.context,
          ...(contextMetadata !== undefined
            ? { contextMetadata }
            : {}),
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
        if (contextMetadata !== undefined) {
          yield* vars.inject("contextMeta", {
            ...(contextMetadata.fileName !== undefined
              ? { fileName: contextMetadata.fileName }
              : {}),
            format: contextMetadata.format,
            chars: contextMetadata.chars,
            lines: contextMetadata.lines,
            ...(contextMetadata.fields !== undefined
              ? { fields: contextMetadata.fields }
              : {}),
            ...(contextMetadata.recordCount !== undefined
              ? { recordCount: contextMetadata.recordCount }
              : {}),
            ...(contextMetadata.sampleRecord !== undefined
              ? { sampleRecord: contextMetadata.sampleRecord }
              : {})
          })
        }

        yield* setCallState(command.callId, state)

        yield* publishEvent(RlmEvent.CallStarted({
          completionId: runtime.completionId,
          callId: command.callId,
          depth: command.depth
        }))

        if (command.callId === rootCallId) {
          yield* traceWriter.writeMeta({
            completionId: runtime.completionId,
            query: command.query,
            contextChars: command.context.length,
            ...(contextMetadata !== undefined ? { contextMetadata } : {}),
            model: config.primaryTarget.model,
            maxIterations: config.maxIterations,
            maxLlmCalls: config.maxLlmCalls,
            startedAt: new Date().toISOString()
          }).pipe(
            Effect.catchAll((error) =>
              Effect.logDebug(`Trace meta write failed: ${String(error)}`))
          )
        }

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
        returnsJsonSchema: t.returnsJsonSchema,
        ...(t.usageExamples !== undefined && t.usageExamples.length > 0
          ? { usageExamples: t.usageExamples }
          : {})
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
          ...(callState.contextMetadata !== undefined
            ? { contextMetadata: callState.contextMetadata }
            : {}),
          sandboxMode: sandboxConfig.sandboxMode,
          ...(config.subModelContextChars !== undefined
            ? { subModelContextChars: config.subModelContextChars }
            : {})
        }),
        query: callState.query,
        ...(callState.contextMetadata !== undefined || callState.context.length > 0
          ? { contextMetadata: callState.contextMetadata ?? analyzeContext(callState.context) }
          : {}),
        transcript,
        enablePromptCaching: config.enablePromptCaching
      })
      const isSubCall = callState.parentBridgeRequestId !== undefined
      const outputMode = callState.outputJsonSchema !== undefined ? "structured" as const : "plain" as const

      // Gate SUBMIT tool: only expose when code has been executed (model has done real work).
      // For no-context or trivial-context calls (< 200 chars), SUBMIT is always available
      // since there's no meaningful data to explore first.
      const submitReady = (yield* hasCodeExecuted(callState)) || callState.context.length < 200

      const response = submitReady
        ? yield* withLlmPermit(
            rlmModel.generateText({
              prompt,
              depth: callState.depth,
              isSubCall,
              toolkit: buildSubmitToolkit(outputMode),
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
                yield* reserveLlmCall(callState.callId)
                return yield* withLlmPermit(
                  rlmModel.generateText({
                    prompt,
                    depth: callState.depth,
                    isSubCall,
                    toolChoice: "none"
                  })
                )
              })
            )
          )
        : yield* withLlmPermit(
            rlmModel.generateText({
              prompt,
              depth: callState.depth,
              isSubCall
            })
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
      const submitAnswer = extractSubmitAnswer(response, {
        outputMode: callState.outputJsonSchema !== undefined ? "structured" : "plain"
      })
      const code = extractCodeBlock(response.text)
      if (submitAnswer._tag === "Found") {
        if (code !== null) {
          yield* publishSchedulerWarning({
            code: "MIXED_SUBMIT_AND_CODE",
            message: "Model returned both SUBMIT and executable code; prioritizing SUBMIT and ignoring code block",
            callId: callState.callId,
            commandTag: command._tag
          })
        }
        const resolvedSubmit = yield* resolveSubmitPayload(callState, submitAnswer.value, response.text).pipe(
          Effect.catchAll((error: OutputValidationError) =>
            Effect.gen(function*() {
              yield* publishSchedulerWarning({
                code: "SUBMIT_RESOLVE_FAILED",
                message: `SUBMIT variable resolution failed: ${error.message}; feeding error back to model for self-correction.`,
                callId: command.callId,
                commandTag: command._tag
              })
              yield* appendTranscript(callState, response.text)
              yield* attachExecutionOutput(callState,
                `\u2717 SUBMIT rejected: ${error.message}\nFix your __vars assignment with code first, then call SUBMIT. Do NOT retry SUBMIT immediately — write a \`\`\`js code block to fix the issue.`
              )
              yield* incrementIteration(callState)
              yield* enqueueOrWarn(RlmCommand.GenerateStep({ callId: callState.callId }))
              return undefined
            })
          )
        )
        if (resolvedSubmit === undefined) return

        yield* enqueueOrWarn(RlmCommand.Finalize({
          callId: callState.callId,
          payload: resolvedSubmit
        }))
        return
      }

      if (submitAnswer._tag === "Invalid") {
        yield* publishSchedulerWarning({
          code: "SUBMIT_INVALID",
          message: `Invalid SUBMIT parameters: ${submitAnswer.message}; feeding error back to model for self-correction.`,
          callId: command.callId,
          commandTag: command._tag
        })
        yield* appendTranscript(callState, response.text)
        yield* attachExecutionOutput(callState,
          `\u2717 SUBMIT rejected: ${submitAnswer.message}\nYou have not completed the task yet. Continue working by writing a \`\`\`js code block. Only call SUBMIT after you have finished and verified your results.`
        )
        yield* incrementIteration(callState)
        yield* enqueueOrWarn(RlmCommand.GenerateStep({ callId: callState.callId }))
        return
      }

      // No SUBMIT — continue REPL via code or additional reasoning turns.
      if (code !== null) {
        yield* resetConsecutiveStalls(callState)
        yield* appendTranscript(callState, response.text)
        yield* incrementIteration(callState)
        yield* enqueueOrWarn(RlmCommand.ExecuteCode({ callId: callState.callId, code }))
        return
      }

      // Neither SUBMIT nor code block — add to transcript and loop.
      const trimmedResponse = response.text.trim()
      let stallCount = 0
      if (trimmedResponse.length <= stallResponseMaxChars) {
        stallCount = yield* incrementConsecutiveStalls(callState)
      } else {
        yield* resetConsecutiveStalls(callState)
      }

      yield* appendTranscript(callState, response.text)
      yield* incrementIteration(callState)

      if (stallCount >= stallConsecutiveLimit) {
        yield* publishSchedulerWarning({
          code: "STALL_DETECTED_EARLY_EXTRACT",
          message: `Detected ${stallCount} consecutive near-empty responses (<= ${stallResponseMaxChars} chars); triggering extract fallback early.`,
          callId: callState.callId,
          commandTag: command._tag
        })
        const nextIteration = yield* readIteration(callState)
        return yield* new BudgetExhaustedError({
          resource: "iterations",
          callId: callState.callId,
          remaining: Math.max(0, config.maxIterations - nextIteration)
        })
      }

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
            ...(callState.contextMetadata !== undefined || callState.context.length > 0
              ? { contextMetadata: callState.contextMetadata ?? analyzeContext(callState.context) }
              : {}),
            transcript,
            enablePromptCaching: config.enablePromptCaching
          })

          const extractOutputMode = callState.outputJsonSchema !== undefined ? "structured" as const : "plain" as const
          const extractToolkit = buildSubmitToolkit(extractOutputMode)
          const response = yield* withLlmPermit(
            rlmModel.generateText({
              prompt: extractPrompt,
              depth: callState.depth,
              isSubCall: callState.parentBridgeRequestId !== undefined,
              toolkit: extractToolkit,
              toolChoice: { tool: SUBMIT_TOOL_NAME },
              disableToolCallResolution: true
            })
          ).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function*() {
                yield* publishSchedulerWarning({
                  code: "TOOLKIT_DEGRADED",
                  message: `Tool-enabled extract failed; retrying extract without tool calling (${formatExecutionError(error)}). Text-mode fallback does not parse textual SUBMIT({ variable: ... }) instructions.`,
                  callId: callState.callId,
                  commandTag: command._tag
                })

                // Fallback extract consumes another LLM budget slot.
                yield* reserveLlmCall(callState.callId)

                return yield* withLlmPermit(
                  rlmModel.generateText({
                    prompt: extractPrompt,
                    depth: callState.depth,
                    isSubCall: callState.parentBridgeRequestId !== undefined,
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
              ...(response.usage.totalTokens !== undefined ? { totalTokens: response.usage.totalTokens } : {}),
              ...(response.usage.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
              ...(response.usage.cachedInputTokens !== undefined
                ? { cachedInputTokens: response.usage.cachedInputTokens }
                : {})
            }
          }))

          const submitAnswer = extractSubmitAnswer(response, {
            outputMode: callState.outputJsonSchema !== undefined ? "structured" : "plain"
          })
          if (submitAnswer._tag === "Found") {
            const resolvedSubmit = yield* resolveSubmitPayload(callState, submitAnswer.value, response.text).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function*() {
                  yield* enqueueOrWarn(RlmCommand.FailCall({
                    callId: command.callId,
                    error
                  }))
                  return undefined
                })
              )
            )
            if (resolvedSubmit === undefined) return

            yield* enqueueOrWarn(RlmCommand.Finalize({
              callId: callState.callId,
              payload: resolvedSubmit
            }))
            return
          }

          if (submitAnswer._tag === "Invalid") {
            yield* enqueueOrWarn(RlmCommand.FailCall({
              callId: command.callId,
              error: new OutputValidationError({
                message: submitAnswer.message,
                raw: response.text
              })
            }))
            return
          }

          yield* enqueueOrWarn(RlmCommand.FailCall({
            callId: command.callId,
            error: new NoFinalAnswerError({ callId: command.callId, maxIterations: config.maxIterations })
          }))
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

      yield* markCodeExecuted(callState)
      yield* attachExecutionOutput(
        callState,
        truncateExecutionOutput(command.output, config.maxExecutionOutputChars)
      )

      const vars = makeCallVariableSpace(callState)
      yield* vars.sync.pipe(
        Effect.catchAll((error) =>
          publishSchedulerWarning({
            code: "VARIABLE_SYNC_FAILED",
            message: `Failed to refresh sandbox variable snapshot after code execution: ${formatExecutionError(error)}. Continuing with cached snapshot.`,
            callId: command.callId,
            commandTag: command._tag
          })
        )
      )

      yield* Effect.fork(
        Effect.gen(function*() {
          const snapshot = yield* vars.cached
          const iteration = yield* readIteration(callState)
          const fullVars: Record<string, unknown> = {}

          for (const variable of snapshot.variables) {
            if (
              variable.name === "context" ||
              variable.name === "contextMeta" ||
              variable.name === "query"
            ) {
              continue
            }
            fullVars[variable.name] = yield* vars.read(variable.name).pipe(
              Effect.catchAll((error) =>
                Effect.succeed(`(read failed: ${formatExecutionError(error)})`))
            )
          }

          yield* traceWriter.writeVarSnapshot({
            callId: callState.callId,
            depth: callState.depth,
            iteration,
            vars: fullVars
          })
        }).pipe(
          Effect.catchAll((error) =>
            Effect.logDebug(`Trace variable snapshot write failed: ${String(error)}`))
        )
      )

      yield* enqueueOrWarn(RlmCommand.GenerateStep({ callId: command.callId }))
    })

  // --- handleHandleBridgeCall ---

  const handleHandleBridgeCall = (command: Extract<RlmCommand, { readonly _tag: "HandleBridgeCall" }>) =>
    Effect.gen(function*() {
      const runOneShotSubCall = (query: string, context: string, depth: number) =>
        Effect.gen(function*() {
          const oneShotPrompt = buildOneShotPrompt({
            systemPrompt: buildOneShotSystemPrompt(),
            query,
            context,
            enablePromptCaching: config.enablePromptCaching
          })

          yield* reserveLlmCall(command.callId)
          const response = yield* withLlmPermit(
            rlmModel.generateText({
              prompt: oneShotPrompt,
              depth,
              isSubCall: true
            })
          )
          yield* recordTokens(command.callId, response.usage.totalTokens)
          return response.text
        }).pipe(
          Effect.retry(bridgeLlmQueryRetryPolicy)
        )

      // Guard: call state may be deleted if call already finalized
      const callStateOption = yield* getCallStateOption(command.callId)
      if (Option.isNone(callStateOption)) {
        yield* publishSchedulerWarning({
          code: "STALE_COMMAND_DROPPED",
          message: `Dropped stale command ${command._tag} for inactive call ${command.callId}`,
          callId: command.callId,
          commandTag: command._tag
        })
        yield* failBridgeDeferred(command.bridgeRequestId, "Call no longer active")
        return
      }
      const callState = callStateOption.value

      yield* publishEvent(RlmEvent.BridgeCallReceived({
        completionId: runtime.completionId,
        callId: command.callId,
        depth: callState.depth,
        method: command.method
      }))

      if (command.method === "llm_query_batched") {
        if (!config.enableLlmQueryBatched) {
          yield* failBridgeDeferred(command.bridgeRequestId, "llm_query_batched is disabled")
          return
        }

        const queriesArg = command.args[0]
        const contextsArg = command.args[1]
        if (!Array.isArray(queriesArg)) {
          yield* failBridgeDeferred(command.bridgeRequestId, "llm_query_batched requires an array of query strings as the first argument")
          return
        }

        const queries: Array<string> = []
        for (let index = 0; index < queriesArg.length; index += 1) {
          const value = queriesArg[index]
          if (typeof value !== "string") {
            yield* failBridgeDeferred(
              command.bridgeRequestId,
              `llm_query_batched query at index ${index} must be a string`
            )
            return
          }
          queries.push(value)
        }

        if (queries.length > config.maxBatchQueries) {
          yield* failBridgeDeferred(
            command.bridgeRequestId,
            `llm_query_batched exceeds maxBatchQueries (${config.maxBatchQueries})`
          )
          return
        }

        let contexts: ReadonlyArray<string> | undefined
        if (contextsArg !== undefined) {
          if (!Array.isArray(contextsArg)) {
            yield* failBridgeDeferred(command.bridgeRequestId, "llm_query_batched contexts must be an array when provided")
            return
          }
          if (contextsArg.length !== queries.length) {
            yield* failBridgeDeferred(command.bridgeRequestId, "llm_query_batched contexts length must match queries length")
            return
          }
          const parsedContexts: Array<string> = []
          for (let index = 0; index < contextsArg.length; index += 1) {
            const value = contextsArg[index]
            if (typeof value !== "string") {
              yield* failBridgeDeferred(
                command.bridgeRequestId,
                `llm_query_batched context at index ${index} must be a string`
              )
              return
            }
            parsedContexts.push(value)
          }
          contexts = parsedContexts
        }

        yield* Effect.forkIn(
          Effect.gen(function*() {
            const results = yield* Effect.forEach(
              queries,
              (query, index) =>
                runOneShotSubCall(query, contexts?.[index] ?? "", callState.depth + 1).pipe(
                  Effect.mapError((error) =>
                    new SandboxError({
                      message: `llm_query_batched item ${index} failed: ${formatExecutionError(error)}`
                    })
                  )
                ),
              { concurrency: config.concurrency }
            )

            yield* resolveBridgeDeferred(command.bridgeRequestId, results)
          }).pipe(
            Effect.catchAll((error) =>
              failBridgeDeferred(command.bridgeRequestId, error)
            )
          ),
          callState.callScope
        )
        return
      }

      // Tool dispatch: methods not reserved for recursive bridgeing route to user-defined tools.
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
            Effect.catchAllCause((cause) => {
              const message = Cause.isFailType(cause)
                ? ("message" in cause.error ? (cause.error as { message: string }).message : String(cause.error))
                : Cause.pretty(cause)
              return failBridgeDeferred(command.bridgeRequestId, message)
            })
          ),
          callState.callScope
        )
        return
      }

      if (callState.depth + 1 >= config.maxDepth) {
        // At max depth: one-shot model call (no REPL protocol) with budget reservation
        yield* Effect.forkIn(
          Effect.gen(function*() {
            const oneShotResponseText = yield* runOneShotSubCall(
              String(command.args[0]),
              String(command.args[1] ?? ""),
              callState.depth + 1
            )
            yield* resolveBridgeDeferred(command.bridgeRequestId, oneShotResponseText)
          }).pipe(
            Effect.catchAllCause((cause) => {
              const message = Cause.isFailType(cause)
                ? ("message" in cause.error ? (cause.error as { message: string }).message : String(cause.error))
                : Cause.pretty(cause)
              return failBridgeDeferred(command.bridgeRequestId, message)
            })
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
      const renderedAnswer = renderSubmitAnswer(command.payload)

      yield* publishEvent(RlmEvent.CallFinalized({
        completionId: runtime.completionId,
        callId: command.callId,
        depth: callState.depth,
        answer: renderedAnswer
      }))

      if (command.callId === rootCallId) {
        yield* traceWriter.writeResult(command.payload).pipe(
          Effect.catchAll((error) =>
            Effect.logDebug(`Trace final result write failed: ${String(error)}`))
        )
      }

      yield* Scope.close(callState.callScope, Exit.void)
      yield* deleteCallState(command.callId)

      if (callState.parentBridgeRequestId) {
        // Sub-call completing → resolve bridge deferred
        if (command.payload.source === "answer") {
          yield* resolveBridgeDeferred(callState.parentBridgeRequestId, command.payload.answer)
          return
        }

        yield* failBridgeDeferred(
          callState.parentBridgeRequestId,
          new OutputValidationError({
            message: "Sub-call finalization must use `SUBMIT({ answer: ... })`.",
            raw: renderedAnswer
          })
        )
      } else if (command.callId === rootCallId) {
        // Fail all outstanding bridge deferreds before queue shutdown
        yield* bridgeStore.failAll("RLM completion finished")
        yield* Deferred.succeed(resultDeferred, command.payload)
        yield* Queue.shutdown(runtime.commands)
      }
    })

  // --- handleFailCall ---

  const handleFailCall = (command: Extract<RlmCommand, { readonly _tag: "FailCall" }>) =>
    Effect.gen(function*() {
      const callStateOption = yield* getCallStateOption(command.callId)
      const callState = Option.isSome(callStateOption)
        ? callStateOption.value
        : undefined
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
        yield* bridgeStore.failAll("RLM completion failed")
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
    bridgeStore.failAll("Scheduler stopped before bridge response")

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
