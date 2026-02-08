import { afterEach, describe, expect, test } from "bun:test"
import type { Subprocess } from "bun"

const WORKER_PATH = new URL("../src/sandbox-worker.ts", import.meta.url).pathname

interface WorkerHandle {
  proc: Subprocess<"ignore", "ignore", "inherit">
  messages: Array<Record<string, unknown>>
  waitForMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>
}

function spawnWorker(): WorkerHandle {
  const messages: Array<Record<string, unknown>> = []
  let waitResolve: ((msg: Record<string, unknown>) => void) | null = null

  const proc = Bun.spawn(["bun", "run", WORKER_PATH], {
    ipc(message) {
      const msg = message as Record<string, unknown>
      // Skip WorkerLog messages
      if (msg._tag === "WorkerLog") return
      messages.push(msg)
      if (waitResolve) {
        const resolve = waitResolve
        waitResolve = null
        resolve(msg)
      }
    },
    serialization: "json",
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit"
  })

  const waitForMessage = (timeoutMs = 5_000): Promise<Record<string, unknown>> => {
    // Check if there's already a message waiting
    const existing = messages.shift()
    if (existing) return Promise.resolve(existing)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waitResolve = null
        reject(new Error("Timeout waiting for IPC message"))
      }, timeoutMs)

      waitResolve = (msg) => {
        clearTimeout(timer)
        // Remove from messages array since we're consuming it directly
        const idx = messages.indexOf(msg)
        if (idx >= 0) messages.splice(idx, 1)
        resolve(msg)
      }
    })
  }

  return { proc, messages, waitForMessage }
}

let handle: WorkerHandle

describe("sandbox-worker", () => {
  afterEach(async () => {
    if (handle?.proc) {
      try {
        handle.proc.kill()
        await handle.proc.exited
      } catch {}
    }
  })

  test("Init and ExecRequest → ExecResult with output", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "req-1",
      code: "print('hello world')"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecResult")
    expect(result.requestId).toBe("req-1")
    expect(result.output).toBe("hello world")
  })

  test("ExecRequest with multiple print calls", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "req-2",
      code: "print('line1'); print('line2')"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecResult")
    expect(result.output).toBe("line1\nline2")
  })

  test("ExecRequest with code that throws → ExecError", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "req-3",
      code: "throw new Error('boom')"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecError")
    expect(result.requestId).toBe("req-3")
    expect(result.message).toBe("boom")
    expect(typeof result.stack).toBe("string")
  })

  test("variable persistence: SetVar → SetVarAck → GetVarRequest → GetVarResult", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    // Set variable
    handle.proc.send({
      _tag: "SetVar",
      requestId: "set-1",
      name: "myVar",
      value: { key: "value" }
    })

    const ack = await handle.waitForMessage()
    expect(ack._tag).toBe("SetVarAck")
    expect(ack.requestId).toBe("set-1")

    // Get variable
    handle.proc.send({
      _tag: "GetVarRequest",
      requestId: "get-1",
      name: "myVar"
    })

    const getResult = await handle.waitForMessage()
    expect(getResult._tag).toBe("GetVarResult")
    expect(getResult.requestId).toBe("get-1")
    expect(getResult.value).toEqual({ key: "value" })
  })

  test("variables persist across code executions", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    // Set via SetVar
    handle.proc.send({
      _tag: "SetVar",
      requestId: "set-1",
      name: "counter",
      value: 0
    })
    await handle.waitForMessage() // SetVarAck

    // Modify via code execution
    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "exec-1",
      code: "__vars.counter = (__vars.counter || 0) + 1; print(__vars.counter)"
    })

    const execResult = await handle.waitForMessage()
    expect(execResult._tag).toBe("ExecResult")
    expect(execResult.output).toBe("1")

    // Read back
    handle.proc.send({
      _tag: "GetVarRequest",
      requestId: "get-1",
      name: "counter"
    })

    const getResult = await handle.waitForMessage()
    expect(getResult.value).toBe(1)
  })

  test("bridge flow: code calls llm_query → BridgeCall → BridgeResult → completion", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "exec-bridge",
      code: "const result = await llm_query('what is 2+2?'); print(result)"
    })

    // First message should be BridgeCall
    const bridgeCall = await handle.waitForMessage()
    expect(bridgeCall._tag).toBe("BridgeCall")
    expect(bridgeCall.method).toBe("llm_query")
    expect(bridgeCall.args).toEqual(["what is 2+2?"])

    // Respond with BridgeResult
    handle.proc.send({
      _tag: "BridgeResult",
      requestId: bridgeCall.requestId,
      result: "4"
    })

    const execResult = await handle.waitForMessage()
    expect(execResult._tag).toBe("ExecResult")
    expect(execResult.output).toBe("4")
  })

  test("bridge flow: code calls llm_query_batched → BridgeCall → BridgeResult → completion", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "exec-bridge-batch",
      code: "const results = await llm_query_batched(['q1', 'q2'], ['c1', 'c2']); print(results.join('|'))"
    })

    const bridgeCall = await handle.waitForMessage()
    expect(bridgeCall._tag).toBe("BridgeCall")
    expect(bridgeCall.method).toBe("llm_query_batched")
    expect(bridgeCall.args).toEqual([["q1", "q2"], ["c1", "c2"]])

    handle.proc.send({
      _tag: "BridgeResult",
      requestId: bridgeCall.requestId,
      result: ["r1", "r2"]
    })

    const execResult = await handle.waitForMessage()
    expect(execResult._tag).toBe("ExecResult")
    expect(execResult.output).toBe("r1|r2")
  })

  test("bridge BridgeFailed → code catches error", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "exec-fail",
      code: `
        try {
          await llm_query('fail please')
        } catch (e) {
          print('caught: ' + e.message)
        }
      `
    })

    // Get BridgeCall
    const bridgeCall = await handle.waitForMessage()
    expect(bridgeCall._tag).toBe("BridgeCall")

    // Send failure
    handle.proc.send({
      _tag: "BridgeFailed",
      requestId: bridgeCall.requestId,
      message: "service unavailable"
    })

    const execResult = await handle.waitForMessage()
    expect(execResult._tag).toBe("ExecResult")
    expect(execResult.output).toBe("caught: service unavailable")
  })

  test("strict mode disables llm_query bridge calls", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, sandboxMode: "strict" })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "strict-no-bridge",
      code: `
        try {
          await llm_query("hello")
        } catch (e) {
          print("caught: " + e.message)
        }
      `
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecResult")
    expect(String(result.output)).toContain("Bridge disabled in strict sandbox mode")

    await Bun.sleep(50)
    expect(handle.messages.some((msg) => msg._tag === "BridgeCall")).toBe(false)
  })

  test("strict mode disables llm_query_batched bridge calls", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, sandboxMode: "strict" })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "strict-no-bridge-batch",
      code: `
        try {
          await llm_query_batched(["q1", "q2"], ["c1", "c2"])
        } catch (e) {
          print("caught: " + e.message)
        }
      `
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecResult")
    expect(String(result.output)).toContain("Bridge disabled in strict sandbox mode")

    await Bun.sleep(50)
    expect(handle.messages.some((msg) => msg._tag === "BridgeCall")).toBe(false)
  })

  test("strict mode blocks dynamic imports", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, sandboxMode: "strict" })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "strict-no-import",
      code: "await import('node:fs')"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecError")
    expect(String(result.message)).toContain("Strict sandbox blocks dynamic module loading")
  })

  test("strict mode blocks constructor escape patterns", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, sandboxMode: "strict" })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "strict-no-constructor-escape",
      code: "print(({}).constructor.constructor('return process.cwd()')())"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecError")
    expect(String(result.message)).toContain("Strict sandbox blocks constructor escape")
  })

  test("strict mode blocks Function constructor", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, sandboxMode: "strict" })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "strict-no-function-constructor",
      code: "print(Function('return 1')())"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecError")
    expect(String(result.message)).toContain("Strict sandbox blocks Function constructor")
  })

  test("strict mode hides ambient globals", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, sandboxMode: "strict" })
    await Bun.sleep(100)

    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "strict-hidden-globals",
      code: "print(typeof Bun); print(typeof process); print(typeof fetch); print(typeof globalThis)"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecResult")
    expect(result.output).toBe("undefined\nundefined\nundefined\nundefined")
  })

  test("Shutdown → clean exit", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    handle.proc.send({ _tag: "Shutdown" })
    const exitCode = await handle.proc.exited
    expect(exitCode).toBe(0)
  })

  test("unknown message tag does not crash worker", async () => {
    handle = spawnWorker()
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0 })
    await Bun.sleep(100)

    // Send unknown tag
    handle.proc.send({ _tag: "Bogus", requestId: "bogus-1" })
    await Bun.sleep(50)

    // Subsequent valid message should still work
    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "req-after-bogus",
      code: "print('still alive')"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecResult")
    expect(result.output).toBe("still alive")
  })

  test("Init with custom maxFrameBytes limits output", async () => {
    handle = spawnWorker()
    // Set very small frame limit
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, maxFrameBytes: 128 })
    await Bun.sleep(100)

    // Execute code producing output larger than 128 bytes
    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "req-oversized",
      code: "print('x'.repeat(200))"
    })

    const result = await handle.waitForMessage()
    expect(result._tag).toBe("ExecError")
    expect(result.message).toBe("Response exceeds max frame size")
  })

  test("oversized BridgeCall rejects bridge promise (not deadlock)", async () => {
    handle = spawnWorker()
    // Set frame limit large enough for ExecResult but too small for the BridgeCall payload
    handle.proc.send({ _tag: "Init", callId: "test-call", depth: 0, maxFrameBytes: 256 })
    await Bun.sleep(100)

    // Execute code that calls llm_query with large payload — should catch the error, not hang
    handle.proc.send({
      _tag: "ExecRequest",
      requestId: "req-bridge-oversized",
      code: `
        try {
          await llm_query('x'.repeat(500))
        } catch (e) {
          print('caught: ' + e.message)
        }
      `
    })

    const result = await handle.waitForMessage(5_000)
    expect(result._tag).toBe("ExecResult")
    expect(String(result.output)).toContain("caught:")
    expect(String(result.output)).toContain("BridgeCall exceeds max frame size")
  })
})
