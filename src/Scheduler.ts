import { Cause, Clock, Deferred, Duration, Effect, Exit, Match, Option, Queue, Ref, Schedule, Scope, Stream } from "effect"
import { consumeIteration, snapshot } from "./Budget"
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
import { LlmCall } from "./LlmCall"
import {
  BudgetExhaustedError,
  SchedulerQueueError,
  NoFinalAnswerError,
  OutputValidationError,
  SandboxError,
  UnknownRlmError,
  type RlmError
} from "./RlmError"
import {
  buildReplPrompt,
  buildOneShotPrompt,
  buildOneShotPromptWithMedia,
  buildExtractPrompt,
  truncateExecutionOutput
} from "./RlmPrompt"
import { buildReplSystemPrompt, buildOneShotSystemPrompt, buildOneShotJsonSystemPrompt, buildExtractSystemPrompt } from "./SystemPrompt"
import { parseAndValidateJson, validateJsonSchema } from "./JsonSchemaValidator"
import {
  buildSubmitToolkit,
  extractSubmitAnswer,
  renderSubmitAnswer,
  SUBMIT_TOOL_NAME,
  type SubmitPayload
} from "./SubmitTool"
import { SandboxConfig, SandboxFactory } from "./Sandbox"
import { RlmRuntime } from "./Runtime"
import {
  BridgeRequestId,
  CallId,
  type CompletionOutcome,
  type FinalAnswerPayload,
  type MediaAttachment,
  type PartialResult,
  RlmCommand,
  RlmEvent
} from "./RlmTypes"
import { RunTraceWriter } from "./RunTraceWriter"
import { makeCallVariableSpace } from "./VariableSpace"
import { getCallStateOption, getCallStateOrWarn, deleteCallState, setCallState } from "./scheduler/CallStateStore"
import { BridgeStore } from "./scheduler/BridgeStore"
import { publishEvent, publishSchedulerWarning } from "./scheduler/Events"
import { enqueue } from "./scheduler/Queue"
import { analyzeContext, type ContextMetadata } from "./ContextMetadata"

import type { RlmToolAny } from "./RlmTool"

export interface RunSchedulerOptions {
  readonly query: string
  readonly context: string
  readonly contextMetadata?: ContextMetadata
  readonly contextTextField?: string
  readonly mediaAttachments?: ReadonlyArray<MediaAttachment>
  readonly depth?: number
  readonly rootCallId?: CallId
  readonly tools?: ReadonlyArray<RlmToolAny>
  readonly outputJsonSchema?: object
  readonly returnPartialOutcome?: boolean
}

const formatExecutionError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message
    return typeof message === "string" ? message : String(message)
  }
  return String(error)
}

// --- Scheduler ---

const runSchedulerInternal = Effect.fn("Scheduler.runInternal")(function*(options: RunSchedulerOptions) {
  const runtime = yield* RlmRuntime
  const rootCallId = options.rootCallId ?? CallId("root")
  const rootDepth = options.depth ?? 0

  const config = yield* RlmConfig
  const llmCall = yield* LlmCall
  const sandboxFactory = yield* SandboxFactory
  const sandboxConfig = yield* SandboxConfig
  const bridgeStore = yield* BridgeStore
  const traceWriter = yield* RunTraceWriter
  const bridgeRetryBaseDelayMs = config.bridgeRetryBaseDelayMs ?? 50
  const bridgeToolRetryCount = config.bridgeToolRetryCount ?? 1

  const bridgeToolRetryPolicy = Schedule.exponential(Duration.millis(bridgeRetryBaseDelayMs)).pipe(
    Schedule.compose(Schedule.recurs(bridgeToolRetryCount))
  )
  const stallConsecutiveLimit = Math.max(1, config.stallConsecutiveLimit ?? 3)
  const stallResponseMaxChars = Math.max(0, config.stallResponseMaxChars ?? 24)

  const resultDeferred = yield* Deferred.make<CompletionOutcome, RlmError>()
  const queueFailureHandled = yield* Ref.make(false)

  const rememberPartialOutcome = (callId: CallId, partial: PartialResult) =>
    Ref.update(runtime.partialOutcomesRef, (current) =>
      new Map([...current, [callId, partial]])
    )

  const takePartialOutcome = (callId: CallId) =>
    Ref.modify(runtime.partialOutcomesRef, (current) => {
      const partial = current.get(callId)
      const next = new Map(current)
      next.delete(callId)
      return [partial, next] as const
    })

  const resolveBridgeDeferred = (bridgeRequestId: BridgeRequestId, value: unknown) =>
    bridgeStore.resolve(bridgeRequestId, value).pipe(Effect.asVoid)

  const failBridgeDeferred = (bridgeRequestId: BridgeRequestId, error: unknown) =>
    bridgeStore.fail(bridgeRequestId, error).pipe(Effect.asVoid)

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

  const handleFatalQueueFailure = (error: SchedulerQueueError) =>
    Effect.gen(function*() {
      const alreadyHandled = yield* Ref.modify(queueFailureHandled, (handled) => [handled, true] as const)
      if (alreadyHandled) return

      yield* publishSchedulerWarning({
        code: "QUEUE_OVERLOADED_FATAL",
        message: `Scheduler command queue ${error.reason} while enqueueing ${error.commandTag}; terminating run.`,
        callId: error.callId as CallId,
        commandTag: error.commandTag
      })
      yield* publishEvent(RlmEvent.CallFailed({
        completionId: runtime.completionId,
        callId: rootCallId,
        depth: rootDepth,
        error
      }))
      yield* failRemainingBridgeDeferreds()
      yield* closeRemainingCallScopes(Exit.fail(error))
      yield* Deferred.fail(resultDeferred, error).pipe(Effect.ignore)
      yield* Queue.shutdown(runtime.commands).pipe(Effect.ignore)
    })

  const budgetSnapshotForSandbox = Effect.gen(function*() {
    const budget = yield* snapshot
    const now = yield* Clock.currentTimeMillis
    const elapsedMs = now - runtime.completionStartedAtMs
    return {
      iterationsRemaining: budget.iterationsRemaining,
      llmCallsRemaining: budget.llmCallsRemaining,
      tokenBudgetRemaining: Option.isSome(budget.tokenBudgetRemaining)
        ? budget.tokenBudgetRemaining.value
        : null,
      totalTokensUsed: budget.totalTokensUsed,
      elapsedMs,
      maxTimeMs: config.maxTimeMs ?? null
    }
  })

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

  const capturePartialResult = (
    callState: CallContext,
    reason: PartialResult["reason"]
  ) =>
    Effect.gen(function*() {
      const transcript = yield* readTranscript(callState)
      const vars = makeCallVariableSpace(callState)
      yield* vars.sync.pipe(
        Effect.catchAll((error) =>
          publishSchedulerWarning({
            code: "VARIABLE_SYNC_FAILED",
            message: `Failed to refresh sandbox variable snapshot while capturing partial result: ${formatExecutionError(error)}. Continuing with cached snapshot.`,
            callId: callState.callId
          })
        )
      )
      const cached = yield* vars.cached

      const values: Record<string, unknown> = {}
      for (const variable of cached.variables) {
        if (variable.name === "context" || variable.name === "contextMeta" || variable.name === "query") {
          continue
        }
        values[variable.name] = yield* vars.read(variable.name).pipe(
          Effect.catchAll((error) =>
            Effect.succeed(`(read failed: ${formatExecutionError(error)})`))
        )
      }

      return {
        source: "partial",
        reason,
        transcript,
        variables: values
      } satisfies PartialResult
    })

  const attemptExtractFallback = (
    callState: CallContext,
    reason: PartialResult["reason"],
    commandTag: RlmCommand["_tag"]
  ) =>
    Effect.gen(function*() {
      const transcript = yield* readTranscript(callState)
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
      const response = yield* llmCall.generateText({
        callId: callState.callId,
        prompt: extractPrompt,
        depth: callState.depth,
        isSubCall: callState.parentBridgeRequestId !== undefined,
        toolkit: extractToolkit,
        toolChoice: { tool: SUBMIT_TOOL_NAME },
        disableToolCallResolution: true
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* publishSchedulerWarning({
              code: "TOOLKIT_DEGRADED",
              message: `Tool-enabled extract failed; retrying extract without tool calling (${formatExecutionError(error)}).`,
              callId: callState.callId,
              commandTag
            })
            return yield* llmCall.generateText({
              callId: callState.callId,
              prompt: extractPrompt,
              depth: callState.depth,
              isSubCall: callState.parentBridgeRequestId !== undefined,
              toolChoice: "none"
            })
          })
        )
      )

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
          ...(response.usage.cachedInputTokens !== undefined ? { cachedInputTokens: response.usage.cachedInputTokens } : {})
        }
      }))

      const submitAnswer = extractSubmitAnswer(response, {
        outputMode: callState.outputJsonSchema !== undefined ? "structured" : "plain"
      })
      if (submitAnswer._tag === "Found") {
        const resolved = yield* Effect.exit(resolveSubmitPayload(callState, submitAnswer.value, response.text))
        if (Exit.isSuccess(resolved)) {
          return {
            _tag: "Final",
            payload: resolved.value
          } satisfies CompletionOutcome
        }
      }

      return {
        _tag: "Partial",
        payload: yield* capturePartialResult(callState, reason)
      } satisfies CompletionOutcome
    }).pipe(
      Effect.catchAll(() =>
        Effect.gen(function*() {
          return {
            _tag: "Partial",
            payload: yield* capturePartialResult(callState, reason)
          } satisfies CompletionOutcome
        })
      )
    )

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
          hasMediaAttachments: command.mediaAttachments !== undefined && command.mediaAttachments.length > 0,
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
          ...(command.mediaAttachments !== undefined && command.mediaAttachments.length > 0
            ? { mediaAttachments: command.mediaAttachments }
            : {}),
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
          const resolvedContextTextField = command.callId === rootCallId
            ? options.contextTextField
            : undefined
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
              : {}),
            ...(contextMetadata.primaryTextField !== undefined
              ? { primaryTextField: contextMetadata.primaryTextField }
              : {}),
            ...(resolvedContextTextField !== undefined
              ? { contextTextField: resolvedContextTextField }
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

        yield* enqueue(RlmCommand.GenerateStep({
          callId: command.callId
        }))
      }).pipe(
        Effect.catchTag("SchedulerQueueError", (error) => Effect.fail(error)),
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            // Close scope directly — CallState was never stored so handleFailCall can't.
            // Use Effect.exit to prevent finalizer failures from masking the original error.
            yield* Effect.exit(Scope.close(callScope, Exit.fail(error)))

            if (command.parentBridgeRequestId) {
              yield* failBridgeDeferred(command.parentBridgeRequestId, error)
            }
            yield* enqueue(RlmCommand.FailCall({
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

      if (config.maxTimeMs !== undefined) {
        const now = yield* Clock.currentTimeMillis
        const elapsedMs = now - runtime.completionStartedAtMs
        if (elapsedMs >= config.maxTimeMs) {
          return yield* new BudgetExhaustedError({
            resource: "time",
            callId: callState.callId,
            remaining: 0
          })
        }
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
            llmCallsRemaining: budget.llmCallsRemaining,
            ...(Option.isSome(budget.tokenBudgetRemaining)
              ? { tokenBudgetRemaining: budget.tokenBudgetRemaining.value }
              : {}),
            totalTokensUsed: budget.totalTokensUsed,
            elapsedMs: Date.now() - runtime.completionStartedAtMs,
            ...(config.maxTimeMs !== undefined ? { maxTimeMs: config.maxTimeMs } : {})
          },
          ...(config.namedModels !== undefined
            ? { namedModelNames: Object.keys(config.namedModels) }
            : {}),
          ...(callState.mediaAttachments !== undefined
            ? { mediaNames: callState.mediaAttachments.map((attachment) => attachment.name) }
            : {}),
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

      // Gate SUBMIT tool: only expose when model has done meaningful work.
      // For large-context calls, require both code execution AND a minimum iteration count
      // to prevent eager models (Gemini) from submitting after a single exploratory step.
      // For no-context or trivial-context calls (< 200 chars), SUBMIT is always available.
      const currentIteration = yield* readIteration(callState)
      const submitReady = callState.context.length < 200
        || ((yield* hasCodeExecuted(callState)) && currentIteration >= 3)

      const response = submitReady
        ? yield* llmCall.generateText({
            callId: callState.callId,
            prompt,
            depth: callState.depth,
            isSubCall,
            toolkit: buildSubmitToolkit(outputMode),
            toolChoice: "auto",
            disableToolCallResolution: true
          }).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function*() {
                yield* publishSchedulerWarning({
                  code: "TOOLKIT_DEGRADED",
                  message: `Tool-enabled generation failed; retrying this iteration without tool calling (${formatExecutionError(error)})`,
                  callId: callState.callId,
                  commandTag: command._tag
                })
                return yield* llmCall.generateText({
                  callId: callState.callId,
                  prompt,
                  depth: callState.depth,
                  isSubCall,
                  toolChoice: "none"
                })
              })
            )
          )
        : yield* llmCall.generateText({
            callId: callState.callId,
            prompt,
            depth: callState.depth,
            isSubCall
          })

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
              yield* enqueue(RlmCommand.GenerateStep({ callId: callState.callId }))
              return undefined
            })
          )
        )
        if (resolvedSubmit === undefined) return

        yield* enqueue(RlmCommand.Finalize({
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
        yield* enqueue(RlmCommand.GenerateStep({ callId: callState.callId }))
        return
      }

      // No SUBMIT — continue REPL via code or additional reasoning turns.
      if (code !== null) {
        yield* resetConsecutiveStalls(callState)
        yield* appendTranscript(callState, response.text)
        yield* incrementIteration(callState)
        yield* enqueue(RlmCommand.ExecuteCode({ callId: callState.callId, code }))
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

      yield* enqueue(RlmCommand.GenerateStep({ callId: callState.callId }))
    }).pipe(
      Effect.catchTag("BudgetExhaustedError", (err) =>
        Effect.gen(function*() {
          const callStateOption = yield* getCallStateOption(command.callId)
          if (Option.isNone(callStateOption)) {
            return yield* enqueue(RlmCommand.FailCall({
              callId: command.callId,
              error: err.resource === "iterations"
                ? new NoFinalAnswerError({ callId: command.callId, maxIterations: config.maxIterations })
                : err
            }))
          }
          const callState = callStateOption.value

          const fallbackOutcome = yield* attemptExtractFallback(callState, err.resource, command._tag)
          if (fallbackOutcome._tag === "Final") {
            yield* enqueue(RlmCommand.Finalize({
              callId: callState.callId,
              payload: fallbackOutcome.payload
            }))
            return
          }

          yield* rememberPartialOutcome(callState.callId, fallbackOutcome.payload)
          const mappedError = err.resource === "iterations"
            ? new NoFinalAnswerError({ callId: command.callId, maxIterations: config.maxIterations })
            : new BudgetExhaustedError({
                resource: err.resource,
                callId: command.callId,
                remaining: 0
              })
          yield* enqueue(RlmCommand.FailCall({
            callId: command.callId,
            error: mappedError
          }))
        })
      ),
      Effect.catchTag("ModelCallError", (error) =>
        enqueue(RlmCommand.FailCall({
          callId: command.callId,
          error
        }))
      ),
      Effect.catchTag("SchedulerQueueError", (error) => Effect.fail(error)),
      Effect.catchAll((error) =>
        enqueue(RlmCommand.FailCall({
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
            enqueue(RlmCommand.CodeExecuted({ callId: command.callId, output }))
          ),
          Effect.catchAll((error) =>
            enqueue(RlmCommand.CodeExecuted({
              callId: command.callId,
              output: `Error: ${formatExecutionError(error)}`
            }))
          ),
          Effect.catchTag("SchedulerQueueError", (error) =>
            handleFatalQueueFailure(error)
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

      yield* enqueue(RlmCommand.GenerateStep({ callId: command.callId }))
    })

  // --- handleHandleBridgeCall ---

  const handleHandleBridgeCall = (command: Extract<RlmCommand, { readonly _tag: "HandleBridgeCall" }>) =>
    Effect.gen(function*() {
      const runOneShotSubCall = (options: {
        readonly query: string
        readonly context: string
        readonly depth: number
        readonly namedModel?: string
        readonly media?: ReadonlyArray<MediaAttachment>
        readonly responseFormat?: { readonly type: string; readonly schema: object }
      }) =>
        Effect.gen(function*() {
          const systemPrompt = options.responseFormat !== undefined
            ? buildOneShotJsonSystemPrompt(options.responseFormat.schema)
            : buildOneShotSystemPrompt()

          const oneShotPrompt = options.media !== undefined && options.media.length > 0
            ? buildOneShotPromptWithMedia({
                systemPrompt,
                query: options.query,
                media: options.media,
                enablePromptCaching: config.enablePromptCaching
              })
            : buildOneShotPrompt({
                systemPrompt,
                query: options.query,
                context: options.context,
                enablePromptCaching: config.enablePromptCaching
              })

          const response = yield* llmCall.generateText({
            callId: command.callId,
            prompt: oneShotPrompt,
            depth: options.depth,
            isSubCall: true,
            ...(options.namedModel !== undefined ? { namedModel: options.namedModel } : {})
          })

          if (options.responseFormat !== undefined) {
            return parseAndValidateJson(response.text, options.responseFormat.schema, { strict: true })
          }
          return response.text
        })

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

      if (command.method === "budget") {
        yield* resolveBridgeDeferred(command.bridgeRequestId, yield* budgetSnapshotForSandbox)
        return
      }

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
          if (value.trim().length === 0) {
            yield* failBridgeDeferred(
              command.bridgeRequestId,
              `llm_query_batched query at index ${index} must be non-empty`
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
                runOneShotSubCall({
                  query,
                  context: contexts?.[index] ?? "",
                  depth: callState.depth + 1
                }).pipe(
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

      if (command.method === "llm_query_with_media") {
        const llmQueryArg = command.args[0]
        if (typeof llmQueryArg !== "string" || llmQueryArg.trim().length === 0) {
          yield* failBridgeDeferred(
            command.bridgeRequestId,
            "llm_query_with_media requires a non-empty prompt string as the first argument"
          )
          return
        }

        const mediaNames = command.args.slice(1)
        if (mediaNames.length === 0) {
          yield* failBridgeDeferred(command.bridgeRequestId, "llm_query_with_media requires at least one media name")
          return
        }
        if (callState.mediaAttachments === undefined || callState.mediaAttachments.length === 0) {
          yield* failBridgeDeferred(command.bridgeRequestId, "No media attachments are registered for this call")
          return
        }

        const mediaByName = new Map(callState.mediaAttachments.map((attachment) => [attachment.name, attachment]))
        const selected: Array<MediaAttachment> = []
        for (let index = 0; index < mediaNames.length; index += 1) {
          const raw = mediaNames[index]
          if (typeof raw !== "string" || raw.trim().length === 0) {
            yield* failBridgeDeferred(
              command.bridgeRequestId,
              `llm_query_with_media media name at index ${index} must be a non-empty string`
            )
            return
          }
          const attachment = mediaByName.get(raw)
          if (attachment === undefined) {
            yield* failBridgeDeferred(command.bridgeRequestId, `Unknown media attachment "${raw}"`)
            return
          }
          selected.push(attachment)
        }

        yield* Effect.forkIn(
          Effect.gen(function*() {
            const oneShotResponseText = yield* runOneShotSubCall({
              query: llmQueryArg,
              context: "",
              depth: callState.depth + 1,
              media: selected
            })
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

      const llmQueryArg = command.args[0]
      if (typeof llmQueryArg !== "string" || llmQueryArg.trim().length === 0) {
        yield* failBridgeDeferred(
          command.bridgeRequestId,
          "llm_query requires a non-empty query string as the first argument"
        )
        return
      }

      const llmContextArg = command.args[1]
      if (llmContextArg !== undefined && typeof llmContextArg !== "string") {
        yield* failBridgeDeferred(
          command.bridgeRequestId,
          "llm_query context must be a string when provided"
        )
        return
      }

      const llmOptionsArg = command.args[2]
      if (
        llmOptionsArg !== undefined &&
        (typeof llmOptionsArg !== "object" || llmOptionsArg === null || Array.isArray(llmOptionsArg))
      ) {
        yield* failBridgeDeferred(
          command.bridgeRequestId,
          "llm_query options must be an object when provided"
        )
        return
      }
      const llmOptions = llmOptionsArg as { readonly model?: unknown; readonly responseFormat?: unknown } | undefined
      const namedModel = llmOptions?.model
      if (namedModel !== undefined && typeof namedModel !== "string") {
        yield* failBridgeDeferred(
          command.bridgeRequestId,
          "llm_query options.model must be a string when provided"
        )
        return
      }

      // Parse responseFormat option
      let responseFormat: { readonly type: string; readonly schema: object } | undefined
      if (llmOptions?.responseFormat !== undefined) {
        const rf = llmOptions.responseFormat
        if (
          typeof rf !== "object" || rf === null || Array.isArray(rf) ||
          !("type" in rf) || (rf as { type: unknown }).type !== "json" ||
          !("schema" in rf) || typeof (rf as { schema: unknown }).schema !== "object" ||
          (rf as { schema: unknown }).schema === null
        ) {
          yield* failBridgeDeferred(
            command.bridgeRequestId,
            "llm_query options.responseFormat must be { type: \"json\", schema: <object> }"
          )
          return
        }
        responseFormat = { type: "json", schema: (rf as { schema: object }).schema }
      }

      if (callState.depth + 1 >= config.maxDepth || namedModel !== undefined) {
        // At max depth: one-shot model call (no REPL protocol) with budget reservation
        yield* Effect.forkIn(
          Effect.gen(function*() {
            const oneShotResult = yield* runOneShotSubCall({
              query: llmQueryArg,
              context: llmContextArg ?? "",
              depth: callState.depth + 1,
              ...(namedModel !== undefined ? { namedModel } : {}),
              ...(responseFormat !== undefined ? { responseFormat } : {})
            })
            yield* resolveBridgeDeferred(command.bridgeRequestId, oneShotResult)
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
        yield* enqueue(RlmCommand.StartCall({
          callId: subCallId,
          depth: callState.depth + 1,
          query: llmQueryArg,
          context: llmContextArg ?? "",
          parentBridgeRequestId: command.bridgeRequestId,
          ...(responseFormat !== undefined ? { outputJsonSchema: responseFormat.schema } : {})
        }))
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
        if (command.payload.source === "value") {
          // Validate against outputJsonSchema if present (recursive responseFormat path)
          if (callState.outputJsonSchema !== undefined) {
            const validationResult = validateJsonSchema(command.payload.value, callState.outputJsonSchema)
            if (!validationResult.valid) {
              yield* failBridgeDeferred(
                callState.parentBridgeRequestId,
                new OutputValidationError({
                  message: `Sub-call structured output schema validation failed: ${validationResult.errors.join("; ")}`,
                  raw: renderedAnswer
                })
              )
              return
            }
          }
          yield* resolveBridgeDeferred(callState.parentBridgeRequestId, command.payload.value)
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
        yield* Deferred.succeed(resultDeferred, {
          _tag: "Final",
          payload: command.payload
        })
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
      const partial = yield* takePartialOutcome(command.callId)
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
        if (partial !== undefined && options.returnPartialOutcome === true) {
          yield* Deferred.succeed(resultDeferred, {
            _tag: "Partial",
            payload: partial
          })
        } else {
          yield* Deferred.fail(resultDeferred, command.error)
        }
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

  const runLoop = Effect.gen(function*() {
    yield* enqueue(RlmCommand.StartCall({
      callId: rootCallId,
      depth: rootDepth,
      query: options.query,
      context: options.context,
      ...(options.mediaAttachments !== undefined && options.mediaAttachments.length > 0
        ? { mediaAttachments: options.mediaAttachments }
        : {}),
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
          Effect.catchTag("SchedulerQueueError", (error) =>
            handleFatalQueueFailure(error)
          )
        )
      )
    )

    return yield* Deferred.await(resultDeferred)
  })

  return yield* runLoop.pipe(
    Effect.catchTag("SchedulerQueueError", (error) =>
      Effect.gen(function*() {
        yield* handleFatalQueueFailure(error)
        return yield* Deferred.await(resultDeferred)
      })
    ),
    Effect.onExit((exit) =>
      Effect.gen(function*() {
        yield* Queue.shutdown(runtime.commands).pipe(Effect.ignore)
        yield* failRemainingBridgeDeferreds()
        yield* closeRemainingCallScopes(exit)
      })
    )
  )
})

export const runSchedulerWithOutcome = Effect.fn("Scheduler.runWithOutcome")(function*(options: RunSchedulerOptions) {
  return yield* runSchedulerInternal({
    ...options,
    returnPartialOutcome: true
  })
})

export const runScheduler = Effect.fn("Scheduler.run")(function*(options: RunSchedulerOptions) {
  const outcome = yield* runSchedulerInternal(options)
  if (outcome._tag === "Final") {
    return outcome.payload
  }

  const config = yield* RlmConfig
  const callId = options.rootCallId ?? CallId("root")
  if (outcome.payload.reason === "iterations") {
    return yield* new NoFinalAnswerError({
      callId,
      maxIterations: config.maxIterations
    })
  }

  return yield* new BudgetExhaustedError({
    resource: outcome.payload.reason,
    callId,
    remaining: 0
  })
})
