import { Data, Deferred, Duration, Effect, FiberSet, Layer, Match, Option, Queue, Ref, Runtime, Stream } from "effect"
import { BridgeHandler } from "./BridgeHandler"
import { SandboxError } from "./RlmError"
import { SandboxConfig, SandboxFactory, type SandboxInstance, type VariableMetadata } from "./Sandbox"
import { checkFrameSize, decodeWorkerToHost, type WorkerToHost } from "./SandboxProtocol"
import type { CallId } from "./RlmTypes"

// --- Local error for precise catchTag on timeout ---

class SandboxTimeoutError extends Data.TaggedClass("SandboxTimeoutError")<{
  readonly requestId: string
}> {}

// --- Types ---

type HealthState = "alive" | "shuttingDown" | "dead"

interface SandboxState {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly health: Ref.Ref<HealthState>
  readonly pendingRequests: Ref.Ref<Map<string, Deferred.Deferred<unknown, SandboxError>>>
  readonly config: SandboxConfig["Type"]
  readonly callId: CallId
}

// --- Helpers ---

const trySend = (proc: ReturnType<typeof Bun.spawn>, message: unknown) =>
  Effect.try({
    try: () => proc.send(message),
    catch: (err) => new SandboxError({ message: `IPC send failed: ${err}` })
  })

const failAllPending = (
  pendingRequests: Ref.Ref<Map<string, Deferred.Deferred<unknown, SandboxError>>>,
  message: string
) =>
  Effect.gen(function*() {
    const pending = yield* Ref.getAndSet(pendingRequests, new Map())
    yield* Effect.forEach([...pending.values()], (d) =>
      Deferred.fail(d, new SandboxError({ message })),
      { discard: true }
    )
  })

const waitForExitWithin = (
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number
) =>
  Effect.promise(() =>
    Promise.race([
      proc.exited.then((code) => Option.some(code)),
      Bun.sleep(timeoutMs).then(() => Option.none<number>())
    ]).catch(() => Option.none<number>())
  )

const killProcess = (
  proc: ReturnType<typeof Bun.spawn>,
  signal: number | NodeJS.Signals
) =>
  Effect.try({
    try: () => proc.kill(signal),
    catch: () => undefined
  }).pipe(Effect.ignore)

const forceTerminateProcess = (
  proc: ReturnType<typeof Bun.spawn>,
  graceMs: number
) =>
  Effect.gen(function*() {
    yield* killProcess(proc, 15)
    const terminated = yield* waitForExitWithin(proc, graceMs)
    if (Option.isSome(terminated)) return

    yield* killProcess(proc, 9)
    yield* waitForExitWithin(proc, graceMs).pipe(Effect.ignore)
  })

const sendRequest = <A>(
  state: SandboxState,
  message: unknown,
  requestId: string,
  timeoutMs: number
) =>
  Effect.gen(function*() {
    const h = yield* Ref.get(state.health)
    if (h !== "alive") return yield* new SandboxError({ message: "Sandbox is dead" })

    if (!checkFrameSize(message, state.config.maxFrameBytes)) {
      return yield* new SandboxError({ message: "Request exceeds max frame size" })
    }

    const deferred = yield* Deferred.make<A, SandboxError>()
    yield* Ref.update(state.pendingRequests, (m) =>
      new Map([...m, [requestId, deferred as Deferred.Deferred<unknown, SandboxError>]])
    )

    return yield* Effect.gen(function*() {
      yield* trySend(state.proc, message)

      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new SandboxTimeoutError({ requestId })
        }),
        Effect.catchTag("SandboxTimeoutError", () =>
          Effect.gen(function*() {
            yield* Ref.set(state.health, "dead")
            yield* failAllPending(state.pendingRequests, "Sandbox killed after timeout")
            yield* forceTerminateProcess(state.proc, state.config.shutdownGraceMs)
            return yield* new SandboxError({ message: `Request ${requestId} timed out` })
          })
        )
      )
    }).pipe(
      Effect.ensuring(
        Ref.update(state.pendingRequests, (m) => {
          const n = new Map(m)
          n.delete(requestId)
          return n
        })
      )
    )
  })

// --- Frame dispatch ---

const resolveRequest = <A>(
  pendingRequests: Ref.Ref<Map<string, Deferred.Deferred<unknown, SandboxError>>>,
  requestId: string,
  tag: string,
  callerCallId: CallId,
  resolve: (deferred: Deferred.Deferred<unknown, SandboxError>) => Effect.Effect<void>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const pending = yield* Ref.get(pendingRequests)
    const deferred = pending.get(requestId)
    if (deferred) {
      yield* resolve(deferred)
    } else {
      yield* Effect.logDebug(`[sandbox:${callerCallId}] Stale ${tag} for request ${requestId.slice(0, 8)} (likely timed out)`)
    }
  })

const dispatchFrame = (
  frame: WorkerToHost,
  pendingRequests: Ref.Ref<Map<string, Deferred.Deferred<unknown, SandboxError>>>,
  proc: ReturnType<typeof Bun.spawn>,
  bridgeHandler: BridgeHandler["Type"],
  bridgeSemaphore: Effect.Semaphore,
  config: SandboxConfig["Type"],
  callerCallId: CallId,
  bridgeFibers: FiberSet.FiberSet<void, SandboxError>
): Effect.Effect<void, never, never> =>
  Match.value(frame).pipe(
    Match.tagsExhaustive({
      ExecResult: (f) =>
        resolveRequest(pendingRequests, f.requestId, "ExecResult", callerCallId,
          (d) => Deferred.succeed(d, f.output)),
      ExecError: (f) =>
        resolveRequest(pendingRequests, f.requestId, "ExecError", callerCallId,
          (d) => Deferred.fail(d, new SandboxError({ message: f.message }))),
      SetVarAck: (f) =>
        resolveRequest(pendingRequests, f.requestId, "SetVarAck", callerCallId,
          (d) => Deferred.succeed(d, undefined)),
      SetVarError: (f) =>
        resolveRequest(pendingRequests, f.requestId, "SetVarError", callerCallId,
          (d) => Deferred.fail(d, new SandboxError({ message: f.message }))),
      GetVarResult: (f) =>
        resolveRequest(pendingRequests, f.requestId, "GetVarResult", callerCallId,
          (d) => Deferred.succeed(d, f.value)),
      ListVarsResult: (f) =>
        resolveRequest(pendingRequests, f.requestId, "ListVarsResult", callerCallId,
          (d) => Deferred.succeed(d, f.variables)),
      BridgeCall: (f) => {
        if (config.sandboxMode === "strict") {
          return trySend(proc, {
            _tag: "BridgeFailed",
            requestId: f.requestId,
            message: "Bridge disabled in strict sandbox mode"
          }).pipe(Effect.ignore)
        }

        // Fork bridge call handling into FiberSet for automatic cleanup on scope close
        return FiberSet.run(bridgeFibers)(
          bridgeSemaphore.withPermits(1)(
            bridgeHandler.handle({
              method: f.method,
              args: f.args,
              callerCallId
            }).pipe(
              Effect.flatMap((result) => {
                const response = { _tag: "BridgeResult" as const, requestId: f.requestId, result }
                if (!checkFrameSize(response, config.maxFrameBytes)) {
                  return trySend(proc, { _tag: "BridgeFailed", requestId: f.requestId, message: "Result too large" })
                }
                return trySend(proc, response)
              }),
              Effect.catchAll((err) =>
                trySend(proc, { _tag: "BridgeFailed", requestId: f.requestId, message: String(err) }).pipe(
                  Effect.ignore
                )
              )
            )
          )
        ).pipe(Effect.asVoid)
      },
      WorkerLog: (f) =>
        Effect.sync(() => {
          // Route worker logs to stderr for diagnostics
          console.error(`[sandbox:${callerCallId}] [${f.level}] ${f.message}`)
        })
    })
  )

// --- Shutdown ---

const shutdownWorker = (
  proc: ReturnType<typeof Bun.spawn>,
  config: SandboxConfig["Type"],
  health: Ref.Ref<HealthState>,
  pendingRequests: Ref.Ref<Map<string, Deferred.Deferred<unknown, SandboxError>>>,
  incomingFrames: Queue.Queue<WorkerToHost>
) =>
  Effect.gen(function*() {
    yield* Ref.set(health, "shuttingDown")
    yield* trySend(proc, { _tag: "Shutdown" }).pipe(Effect.ignore)

    const exitedGracefully = yield* waitForExitWithin(proc, config.shutdownGraceMs)
    if (Option.isNone(exitedGracefully)) {
      yield* forceTerminateProcess(proc, config.shutdownGraceMs)
    }

    yield* Ref.set(health, "dead")
    yield* failAllPending(pendingRequests, "Sandbox shut down")
    yield* Queue.shutdown(incomingFrames)
  })

// --- Instance creation ---

import type { ToolDescriptorForSandbox } from "./Sandbox"

const createSandboxInstance = (
  options: { callId: CallId; depth: number; tools?: ReadonlyArray<ToolDescriptorForSandbox> },
  bridgeHandler: BridgeHandler["Type"],
  config: SandboxConfig["Type"]
) =>
  Effect.gen(function*() {
    const bunExecutable = Bun.which("bun") ?? "bun"
    const strictSandboxCwd = Bun.env.TMPDIR ?? process.env.TMPDIR ?? "/tmp"
    const strictMode = config.sandboxMode === "strict"
    const health = yield* Ref.make<HealthState>("alive")
    const pendingRequests = yield* Ref.make(new Map<string, Deferred.Deferred<unknown, SandboxError>>())
    const incomingFrames = yield* Queue.bounded<WorkerToHost>(config.incomingFrameQueueCapacity)
    const bridgeSemaphore = yield* Effect.makeSemaphore(config.maxBridgeConcurrency)
    const bridgeFibers = yield* FiberSet.make<void, SandboxError>()
    const runtime = yield* Effect.runtime<never>()
    const runFork = Runtime.runFork(runtime)

    const markDead = (message: string) =>
      Effect.gen(function*() {
        const currentHealth = yield* Ref.get(health)
        if (currentHealth === "dead") return
        yield* Ref.set(health, "dead")
        yield* failAllPending(pendingRequests, message)
        yield* Queue.shutdown(incomingFrames)
      })

    // Mutable ref for proc — callbacks need it but Bun.spawn returns proc after callbacks are registered.
    // Safe because IPC callbacks only fire after spawn completes and messages arrive (post-Init).
    let procHandle: ReturnType<typeof Bun.spawn> | null = null

    // Spawn subprocess (acquireRelease in caller's scope)
    const proc = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const p = Bun.spawn([bunExecutable, "run", config.workerPath], {
          ipc(rawMessage) {
            try {
              if (!checkFrameSize(rawMessage, config.maxFrameBytes)) {
                console.error(`[sandbox:${options.callId}] Fatal: oversized frame from worker, killing sandbox`)
                runFork(markDead("Worker sent oversized frame"))
                procHandle?.kill(9)
                return
              }

              const frame = decodeWorkerToHost(rawMessage)
              const offered = Queue.unsafeOffer(incomingFrames, frame)
              if (!offered) {
                console.error(`[sandbox:${options.callId}] Fatal: incoming frame queue overflow, killing sandbox`)
                runFork(markDead("Worker overwhelmed frame queue"))
                procHandle?.kill(9)
              }
            } catch (err) {
              console.error(`[sandbox:${options.callId}] Fatal: malformed frame from worker, killing sandbox`, err)
              runFork(markDead("Worker sent malformed frame"))
              procHandle?.kill(9)
            }
          },
          onDisconnect() {
            runFork(
              Effect.gen(function*() {
                const h = yield* Ref.get(health)
                if (h === "alive") {
                  yield* markDead("Worker IPC disconnected")
                }
              })
            )
          },
          serialization: "json",
          ...(strictMode ? { cwd: strictSandboxCwd, env: {} } : {}),
          stdin: "ignore",
          stdout: "ignore",
          stderr: strictMode ? "ignore" : "inherit"
        })
        procHandle = p
        return p
      }),
      (p) => shutdownWorker(p, config, health, pendingRequests, incomingFrames)
    )

    // Exit watcher — detect unexpected exits
    yield* Effect.forkScoped(
      Effect.gen(function*() {
        yield* Effect.tryPromise(() => proc.exited)
        const currentHealth = yield* Ref.get(health)
        if (currentHealth === "alive") {
          yield* Ref.set(health, "dead")
          yield* failAllPending(pendingRequests, "Worker exited unexpectedly")
          yield* Queue.shutdown(incomingFrames)
        }
      }).pipe(Effect.catchAll(() => Effect.void))
    )

    // Frame dispatcher fiber
    yield* Effect.forkScoped(
      Stream.fromQueue(incomingFrames).pipe(
        Stream.runForEach((frame) =>
          dispatchFrame(frame, pendingRequests, proc, bridgeHandler, bridgeSemaphore, config, options.callId, bridgeFibers)
        )
      )
    )

    // Send Init
    yield* trySend(proc, {
      _tag: "Init",
      callId: options.callId,
      depth: options.depth,
      sandboxMode: config.sandboxMode,
      maxFrameBytes: config.maxFrameBytes,
      ...(options.tools !== undefined && options.tools.length > 0
        ? { tools: options.tools }
        : {})
    })

    const state: SandboxState = { proc, health, pendingRequests, config, callId: options.callId }

    return {
      execute: (code: string) => {
        const requestId = crypto.randomUUID()
        return sendRequest<string>(
          state,
          { _tag: "ExecRequest", requestId, code },
          requestId,
          config.executeTimeoutMs
        )
      },
      setVariable: (name: string, value: unknown) => {
        const requestId = crypto.randomUUID()
        return sendRequest<void>(
          state,
          { _tag: "SetVar", requestId, name, value },
          requestId,
          config.setVarTimeoutMs
        )
      },
      getVariable: (name: string) => {
        const requestId = crypto.randomUUID()
        return sendRequest<unknown>(
          state,
          { _tag: "GetVarRequest", requestId, name },
          requestId,
          config.getVarTimeoutMs
        )
      },
      listVariables: () => {
        const requestId = crypto.randomUUID()
        return sendRequest<ReadonlyArray<VariableMetadata>>(
          state,
          { _tag: "ListVarsRequest", requestId },
          requestId,
          config.listVarTimeoutMs
        )
      }
    } satisfies SandboxInstance
  })

// --- Layer ---

export const SandboxBunLive: Layer.Layer<SandboxFactory, never, BridgeHandler> =
  Layer.effect(
    SandboxFactory,
    Effect.gen(function*() {
      const bridgeHandler = yield* BridgeHandler
      const config = yield* SandboxConfig
      return SandboxFactory.of({
        create: (options) => createSandboxInstance(options, bridgeHandler, config)
      })
    })
  )
