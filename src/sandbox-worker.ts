/**
 * Sandbox worker — standalone Bun subprocess entry point.
 * Does NOT import Effect. Communicates with host via Bun IPC (JSON serialization).
 *
 * Trust model: process-level isolation only.
 * "strict" mode is best-effort JavaScript-level hardening, not a security boundary.
 */

// --- State ---

const vars = new Map<string, unknown>()
let workerCallId = "unknown"
let workerDepth = 0
let sandboxMode: "permissive" | "strict" = "permissive"

// Pending bridge calls: requestId → { resolve, reject }
const pendingBridge = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
>()

// Max frame size (configurable via Init, default 4MB)
let maxFrameBytes = 4 * 1024 * 1024

const STRICT_BLOCKLIST = [
  /\bimport\s*\(/,
  /\brequire\s*\(/
]

const makeStrictScope = (
  print: (...args: unknown[]) => void,
  __vars: unknown,
  llm_query: (query: string, context?: string) => Promise<unknown>
) => {
  const scope: Record<string, unknown> = {
    // Explicitly provided worker bindings
    print,
    __vars,
    llm_query,
    undefined,

    // Common JS built-ins
    Array,
    ArrayBuffer,
    BigInt,
    BigInt64Array,
    BigUint64Array,
    Boolean,
    DataView,
    Date,
    Error,
    EvalError,
    Float32Array,
    Float64Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
    Intl,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RangeError,
    ReferenceError,
    RegExp,
    Set,
    String,
    Symbol,
    SyntaxError,
    TypeError,
    URIError,
    URL,
    URLSearchParams,
    WeakMap,
    WeakSet,
    atob,
    btoa,
    clearInterval,
    clearTimeout,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    setInterval,
    setTimeout,
    crypto
  }

  return new Proxy(scope, {
    has() {
      // Prevent fallback resolution to ambient globals.
      return true
    },
    get(target, prop) {
      if (typeof prop !== "string") return undefined
      return Object.prototype.hasOwnProperty.call(target, prop)
        ? target[prop]
        : undefined
    },
    set() {
      return false
    }
  })
}

// --- Helpers ---

function checkFrameSize(message: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(message)).byteLength <= maxFrameBytes
  } catch {
    // Non-serializable (BigInt, circular ref, etc.) — frame cannot be sent
    return false
  }
}

function safeSend(message: unknown): boolean {
  const msg = message as Record<string, unknown>
  if (!checkFrameSize(message)) {
    if (msg._tag === "BridgeCall") {
      // Reject the pending bridge promise directly so executeCode can continue
      const bridgeRequestId = String(msg.requestId)
      const pending = pendingBridge.get(bridgeRequestId)
      if (pending) {
        pendingBridge.delete(bridgeRequestId)
        pending.reject(new Error("BridgeCall exceeds max frame size"))
      }
      return false
    }
    // For other message types: send truncated error to host
    const fallback = {
      _tag: "ExecError" as const,
      requestId: String(msg.requestId ?? "unknown"),
      message: "Response exceeds max frame size"
    }
    process.send!(fallback)
    return false
  }
  process.send!(message)
  return true
}

// --- Code execution ---

async function executeCode(requestId: string, code: string): Promise<void> {
  const output: string[] = []

  // Injected bindings
  const print = (...args: unknown[]) => {
    output.push(args.map(String).join(" "))
  }

  const __vars = new Proxy(vars, {
    get(_target, prop: string) {
      return vars.get(prop)
    },
    set(_target, prop: string, value: unknown) {
      vars.set(prop, value)
      return true
    },
    has(_target, prop: string) {
      return vars.has(prop)
    }
  })

  const llm_query = async (query: string, context?: string): Promise<unknown> => {
    if (sandboxMode === "strict") {
      throw new Error("Bridge disabled in strict sandbox mode")
    }

    const bridgeRequestId = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      pendingBridge.set(bridgeRequestId, { resolve, reject })
      safeSend({
        _tag: "BridgeCall",
        requestId: bridgeRequestId,
        method: "llm_query",
        args: context !== undefined ? [query, context] : [query]
      })
    })
  }

  try {
    if (sandboxMode === "strict") {
      for (const pattern of STRICT_BLOCKLIST) {
        if (pattern.test(code)) {
          throw new Error("Strict sandbox blocks dynamic module loading")
        }
      }
    }

    // AsyncFunction constructor to allow top-level await in code
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
    if (sandboxMode === "strict") {
      const strictScope = makeStrictScope(print, __vars, llm_query)
      const fn = new AsyncFunction("print", "__vars", "llm_query", "__strictScope", `
        with (__strictScope) {
          ${code}
        }
      `)
      await fn(print, __vars, llm_query, strictScope)
    } else {
      const fn = new AsyncFunction("print", "__vars", "llm_query", code)
      await fn(print, __vars, llm_query)
    }

    safeSend({
      _tag: "ExecResult",
      requestId,
      output: output.join("\n")
    })
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    safeSend({
      _tag: "ExecError",
      requestId,
      message: error.message,
      stack: error.stack
    })
  }
}

// --- Message dispatch ---

function handleMessage(message: unknown): void {
  if (typeof message !== "object" || message === null || !("_tag" in message)) {
    return
  }

  const msg = message as Record<string, unknown>

  switch (msg._tag) {
    case "Init": {
      workerCallId = String(msg.callId ?? "unknown")
      workerDepth = Number(msg.depth ?? 0)
      sandboxMode = msg.sandboxMode === "strict" ? "strict" : "permissive"
      if (typeof msg.maxFrameBytes === "number" && msg.maxFrameBytes > 0 &&
          Number.isInteger(msg.maxFrameBytes) && msg.maxFrameBytes <= 64 * 1024 * 1024) {
        maxFrameBytes = msg.maxFrameBytes
      }
      console.error(`[sandbox-worker] Init: callId=${workerCallId} depth=${workerDepth} mode=${sandboxMode} maxFrameBytes=${maxFrameBytes}`)
      break
    }

    case "ExecRequest": {
      const requestId = String(msg.requestId)
      const code = String(msg.code)
      executeCode(requestId, code)
      break
    }

    case "SetVar": {
      const requestId = String(msg.requestId)
      try {
        vars.set(String(msg.name), msg.value)
        safeSend({ _tag: "SetVarAck", requestId })
      } catch (err: unknown) {
        safeSend({
          _tag: "SetVarError",
          requestId,
          message: err instanceof Error ? err.message : String(err)
        })
      }
      break
    }

    case "GetVarRequest": {
      const requestId = String(msg.requestId)
      const value = vars.get(String(msg.name))
      safeSend({ _tag: "GetVarResult", requestId, value })
      break
    }

    case "BridgeResult": {
      const requestId = String(msg.requestId)
      const pending = pendingBridge.get(requestId)
      if (pending) {
        pendingBridge.delete(requestId)
        pending.resolve(msg.result)
      }
      break
    }

    case "BridgeFailed": {
      const requestId = String(msg.requestId)
      const pending = pendingBridge.get(requestId)
      if (pending) {
        pendingBridge.delete(requestId)
        pending.reject(new Error(String(msg.message)))
      }
      break
    }

    case "Shutdown": {
      // Reject all pending bridge calls
      for (const [id, pending] of pendingBridge) {
        pending.reject(new Error("Worker shutting down"))
        pendingBridge.delete(id)
      }
      process.exit(0)
      break
    }

    default:
      console.error(`[sandbox-worker] Unknown message tag: ${String(msg._tag)}`)
      break
  }
}

// --- IPC listener ---

process.on("message", handleMessage)

process.on("disconnect", () => {
  for (const [id, pending] of pendingBridge) {
    pending.reject(new Error("Parent process disconnected"))
    pendingBridge.delete(id)
  }
  process.exit(1)
})
