import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Scope } from "effect"
import { BridgeHandler } from "./BridgeHandler"
import { SandboxError } from "./RlmError"
import { SandboxConfig, SandboxFactory } from "./Sandbox"
import { SandboxBunLive } from "./SandboxBun"
import type { CallId } from "./RlmTypes"

// Mock BridgeHandler that resolves with a fixed response
const makeBridgeHandlerLayer = (
  handler?: (options: { method: string; args: ReadonlyArray<unknown>; callerCallId: CallId }) => Effect.Effect<unknown, SandboxError>
) =>
  Layer.succeed(
    BridgeHandler,
    BridgeHandler.of({
      handle: handler ?? (() => Effect.succeed("bridge-response"))
    })
  )

const testConfig = {
  executeTimeoutMs: 10_000,
  setVarTimeoutMs: 5_000,
  getVarTimeoutMs: 5_000,
  shutdownGraceMs: 2_000,
  maxFrameBytes: 4 * 1024 * 1024,
  maxBridgeConcurrency: 4,
  workerPath: new URL("./sandbox-worker.ts", import.meta.url).pathname
}

const makeTestLayer = (
  bridgeHandler?: (options: { method: string; args: ReadonlyArray<unknown>; callerCallId: CallId }) => Effect.Effect<unknown, SandboxError>,
  configOverrides?: Partial<typeof testConfig>
) => {
  const sandboxLayer = Layer.provide(SandboxBunLive, makeBridgeHandlerLayer(bridgeHandler))
  if (configOverrides) {
    return Layer.provide(sandboxLayer, Layer.succeed(SandboxConfig, { ...testConfig, ...configOverrides }))
  }
  return Layer.provide(sandboxLayer, Layer.succeed(SandboxConfig, testConfig))
}

describe("SandboxBun", () => {
  test("execute returns code output", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const factory = yield* SandboxFactory
          const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 })
          return yield* sandbox.execute("print('hello from sandbox')")
        })
      ).pipe(Effect.provide(makeTestLayer()))
    )

    expect(result).toBe("hello from sandbox")
  })

  test("setVariable and getVariable round-trip", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const factory = yield* SandboxFactory
          const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 })
          yield* sandbox.setVariable("myKey", { nested: [1, 2, 3] })
          return yield* sandbox.getVariable("myKey")
        })
      ).pipe(Effect.provide(makeTestLayer()))
    )

    expect(result).toEqual({ nested: [1, 2, 3] })
  })

  test("variables persist across executions", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const factory = yield* SandboxFactory
          const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 })

          yield* sandbox.setVariable("counter", 10)
          yield* sandbox.execute("__vars.counter = __vars.counter + 5")
          return yield* sandbox.getVariable("counter")
        })
      ).pipe(Effect.provide(makeTestLayer()))
    )

    expect(result).toBe(15)
  })

  test("code error returns SandboxError", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const factory = yield* SandboxFactory
          const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 })
          return yield* sandbox.execute("throw new Error('intentional')").pipe(Effect.either)
        })
      ).pipe(Effect.provide(makeTestLayer()))
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(SandboxError)
      expect(result.left.message).toBe("intentional")
    }
  })

  test("scope close kills subprocess", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const factory = yield* SandboxFactory
        const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 }).pipe(
          Effect.provideService(Scope.Scope, scope)
        )

        // Verify it's alive
        const output = yield* sandbox.execute("print('alive')")
        expect(output).toBe("alive")

        // Close scope
        yield* Scope.close(scope, Exit.void)

        // Subsequent calls should fail
        const result = yield* sandbox.execute("print('dead')").pipe(Effect.either)
        expect(result._tag).toBe("Left")
      }).pipe(Effect.provide(makeTestLayer()))
    )
  })

  test("bridge call flows through BridgeHandler", async () => {
    const bridgeCalls: Array<{ method: string; args: ReadonlyArray<unknown> }> = []

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const factory = yield* SandboxFactory
          const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 })
          return yield* sandbox.execute("const r = await llm_query('hello', 'ctx'); print(r)")
        })
      ).pipe(
        Effect.provide(
          makeTestLayer(({ method, args }) => {
            bridgeCalls.push({ method, args: [...args] })
            return Effect.succeed("bridge-42")
          })
        )
      )
    )

    expect(result).toBe("bridge-42")
    expect(bridgeCalls).toHaveLength(1)
    expect(bridgeCalls[0]!.method).toBe("llm_query")
    expect(bridgeCalls[0]!.args).toEqual(["hello", "ctx"])
  })

  test("execute timeout returns SandboxError", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const factory = yield* SandboxFactory
          const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 })
          // Code that never completes — worker stays alive but never responds
          return yield* sandbox.execute("await new Promise(() => {})").pipe(Effect.either)
        })
      ).pipe(
        Effect.provide(
          makeTestLayer(undefined, { executeTimeoutMs: 500 })
        ),
        // Use Effect.timeout as belt-and-suspenders
        Effect.timeout("10 seconds")
      )
    )

    // Effect.timeout wraps in Option, but either should resolve first
    expect(result).not.toBeUndefined()
    if (result && "_tag" in result) {
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(SandboxError)
        expect(result.left.message).toContain("timed out")
      }
    }
  }, 30_000)

  test("send after kill returns typed SandboxError (not defect)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const factory = yield* SandboxFactory
        const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 }).pipe(
          Effect.provideService(Scope.Scope, scope)
        )

        // Verify sandbox is alive
        const output = yield* sandbox.execute("print('alive')")
        expect(output).toBe("alive")

        // Close scope (kills the subprocess)
        yield* Scope.close(scope, Exit.void)

        // Subsequent call should return SandboxError, not a defect
        return yield* sandbox.execute("print('dead')").pipe(Effect.either)
      }).pipe(Effect.provide(makeTestLayer()))
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(SandboxError)
    }
  })

  test("scope close fails pending execute immediately (not after timeout)", async () => {
    const start = Date.now()

    await Effect.runPromise(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const factory = yield* SandboxFactory
        const sandbox = yield* factory.create({ callId: "test" as CallId, depth: 0 }).pipe(
          Effect.provideService(Scope.Scope, scope)
        )

        // Verify sandbox is alive
        const alive = yield* sandbox.execute("print('alive')")
        expect(alive).toBe("alive")

        // Close scope — triggers shutdown, which kills process and fails pending requests
        yield* Scope.close(scope, Exit.void)

        // Subsequent execute should fail immediately with SandboxError (not hang until timeout)
        const result = yield* sandbox.execute("print('dead')").pipe(Effect.either)
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(SandboxError)
        }
      }).pipe(
        Effect.provide(makeTestLayer(undefined, { executeTimeoutMs: 30_000 }))
      )
    )

    const elapsed = Date.now() - start
    // Should complete well before the 30s execute timeout
    expect(elapsed).toBeLessThan(5_000)
  }, 10_000)
})
