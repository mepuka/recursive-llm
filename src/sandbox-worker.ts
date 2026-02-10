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
let toolFunctions: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

// Pending bridge calls: requestId → { resolve, reject }
const pendingBridge = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
>()

// Max frame size (configurable via Init, default 4MB)
let maxFrameBytes = 4 * 1024 * 1024

const STRICT_BLOCKLIST: ReadonlyArray<{
  readonly pattern: RegExp
  readonly message: string
}> = [
  {
    pattern: /\bimport\s*\(/,
    message: "Strict sandbox blocks dynamic module loading"
  },
  {
    pattern: /\brequire\s*\(/,
    message: "Strict sandbox blocks dynamic module loading"
  },
  {
    pattern: /\bFunction\s*\(/,
    message: "Strict sandbox blocks Function constructor"
  },
  {
    pattern: /\.\s*constructor\s*\.\s*constructor\s*\(/,
    message: "Strict sandbox blocks constructor escape"
  },
  {
    pattern: /\.\s*constructor\s*\(/,
    message: "Strict sandbox blocks constructor escape"
  }
]

const makeStrictScope = (
  print: (...args: unknown[]) => void,
  __vars: unknown,
  llm_query: (query: string, context?: string) => Promise<unknown>,
  llm_query_batched: (queries: ReadonlyArray<string>, contexts?: ReadonlyArray<string>) => Promise<unknown>,
  init_corpus: (documents: unknown, options?: unknown) => Promise<unknown>,
  init_corpus_from_context: (options?: unknown) => Promise<unknown>,
  tools?: Record<string, (...args: unknown[]) => Promise<unknown>>
) => {
  const scope: Record<string, unknown> = {
    // Explicitly provided worker bindings
    print,
    __vars,
    llm_query,
    llm_query_batched,
    init_corpus,
    init_corpus_from_context,
    undefined,
    // Tool functions
    ...tools,

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

  const llm_query_batched = async (
    queries: ReadonlyArray<string>,
    contexts?: ReadonlyArray<string>
  ): Promise<unknown> => {
    if (sandboxMode === "strict") {
      throw new Error("Bridge disabled in strict sandbox mode")
    }

    const bridgeRequestId = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      pendingBridge.set(bridgeRequestId, { resolve, reject })
      safeSend({
        _tag: "BridgeCall",
        requestId: bridgeRequestId,
        method: "llm_query_batched",
        args: contexts !== undefined ? [queries, contexts] : [queries]
      })
    })
  }

  interface CorpusDocument {
    readonly id: string
    readonly text: string
  }

  interface InitCorpusOptions {
    readonly corpusId?: string
    readonly batchSize?: number
    readonly dedupeById?: boolean
    readonly maxDocuments?: number
    readonly textField?: string
  }

  const toObject = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : {}

  const toNonEmptyString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined

  const toPositiveInteger = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
      ? value
      : fallback

  const toolOrThrow = (toolName: string): ((...args: unknown[]) => Promise<unknown>) => {
    const fn = toolFunctions[toolName]
    if (fn) return fn
    throw new Error(`Required NLP tool "${toolName}" is unavailable in this run`)
  }

  const pickTextFromRecord = (record: Record<string, unknown>, textField?: string): string => {
    if (textField !== undefined) {
      const explicit = record[textField]
      if (typeof explicit === "string") return explicit
    }

    const candidateFields = ["text", "content", "body", "message", "summary", "title"]
    for (const field of candidateFields) {
      const value = record[field]
      if (typeof value === "string") return value
    }

    const firstString = Object.values(record).find((value) => typeof value === "string")
    if (typeof firstString === "string") return firstString

    try {
      return JSON.stringify(record)
    } catch {
      return String(record)
    }
  }

  const toCorpusDocument = (
    value: unknown,
    index: number,
    textField?: string
  ): CorpusDocument | undefined => {
    if (typeof value === "string") {
      const text = value.trim()
      if (text.length === 0) return undefined
      return { id: String(index), text }
    }

    const record = toObject(value)
    if (Object.keys(record).length === 0) return undefined

    const rawId = record.id ?? record._id
    const id =
      typeof rawId === "string" || typeof rawId === "number" || typeof rawId === "bigint"
        ? String(rawId)
        : String(index)

    const text = pickTextFromRecord(record, textField).trim()
    if (text.length === 0) return undefined

    return { id, text }
  }

  const parseDelimitedRecords = (context: string, delimiter: "," | "\t"): Array<Record<string, unknown>> => {
    const lines = context
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    if (lines.length < 2) return []

    const header = lines[0]!.split(delimiter).map((cell) => cell.trim())
    const rows = lines.slice(1)
    const records: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const cells = row.split(delimiter)
      const record: Record<string, unknown> = {}
      for (let i = 0; i < header.length; i += 1) {
        const key = header[i]
        if (!key || key.length === 0) continue
        record[key] = (cells[i] ?? "").trim()
      }
      records.push(record)
    }
    return records
  }

  const inferCorpusId = (createResult: unknown, requestedCorpusId?: string): string => {
    if (requestedCorpusId !== undefined) return requestedCorpusId

    const fromResult = toObject(createResult).corpusId
    if (typeof fromResult === "string" && fromResult.length > 0) {
      return fromResult
    }

    throw new Error("CreateCorpus did not return a corpusId; provide options.corpusId explicitly")
  }

  const learnIntoCorpus = async (
    rawDocuments: ReadonlyArray<unknown>,
    options?: InitCorpusOptions
  ): Promise<{
    corpusId: string
    documentsLearned: number
    batches: number
    batchSize: number
    dedupeById: boolean
  }> => {
    const normalizedOptions = toObject(options)
    const requestedCorpusId = toNonEmptyString(normalizedOptions.corpusId)
    const textField = toNonEmptyString(normalizedOptions.textField)
    const batchSize = toPositiveInteger(normalizedOptions.batchSize, 500)
    const dedupeById = normalizedOptions.dedupeById !== false
    const maxDocuments = toPositiveInteger(normalizedOptions.maxDocuments, Number.MAX_SAFE_INTEGER)

    const normalizedDocuments = rawDocuments
      .map((value, index) => toCorpusDocument(value, index, textField))
      .filter((value): value is CorpusDocument => value !== undefined)
      .slice(0, maxDocuments)

    if (normalizedDocuments.length === 0) {
      throw new Error("No corpus documents were produced from input")
    }

    const createCorpus = toolOrThrow("CreateCorpus")
    const learnCorpus = toolOrThrow("LearnCorpus")

    const createResult = requestedCorpusId !== undefined
      ? await createCorpus(requestedCorpusId)
      : await createCorpus()

    const corpusId = inferCorpusId(createResult, requestedCorpusId)

    let batches = 0
    for (let index = 0; index < normalizedDocuments.length; index += batchSize) {
      const batch = normalizedDocuments.slice(index, index + batchSize)
      await learnCorpus(corpusId, batch, dedupeById)
      batches += 1
    }

    vars.set("contextCorpusId", corpusId)

    return {
      corpusId,
      documentsLearned: normalizedDocuments.length,
      batches,
      batchSize,
      dedupeById
    }
  }

  const init_corpus = async (
    documents: unknown,
    options?: unknown
  ): Promise<unknown> => {
    if (!Array.isArray(documents)) {
      throw new Error("init_corpus requires an array of documents")
    }

    return learnIntoCorpus(documents, options as InitCorpusOptions | undefined)
  }

  const init_corpus_from_context = async (options?: unknown): Promise<unknown> => {
    const context = vars.get("context")
    if (typeof context !== "string" || context.trim().length === 0) {
      throw new Error("__vars.context is empty; nothing to index")
    }

    const normalizedOptions = toObject(options)
    const contextMeta = toObject(vars.get("contextMeta"))
    const format = toNonEmptyString(contextMeta.format)

    let sourceDocuments: Array<unknown> = []

    if (format === "ndjson") {
      sourceDocuments = context
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .filter((value) => value !== undefined)
    } else if (format === "json-array") {
      const parsed = JSON.parse(context)
      if (!Array.isArray(parsed)) {
        throw new Error("__vars.contextMeta.format is json-array but parsed context is not an array")
      }
      sourceDocuments = parsed
    } else if (format === "csv") {
      sourceDocuments = parseDelimitedRecords(context, ",")
    } else if (format === "tsv") {
      sourceDocuments = parseDelimitedRecords(context, "\t")
    } else if (format === "json") {
      sourceDocuments = [JSON.parse(context)]
    } else {
      sourceDocuments = context
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    }

    if (sourceDocuments.length === 0) {
      throw new Error("No records found in __vars.context for corpus initialization")
    }

    return learnIntoCorpus(sourceDocuments, normalizedOptions as InitCorpusOptions)
  }

  try {
    if (sandboxMode === "strict") {
      for (const blocked of STRICT_BLOCKLIST) {
        if (blocked.pattern.test(code)) {
          throw new Error(blocked.message)
        }
      }
    }

    // AsyncFunction constructor to allow top-level await in code
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
    const injectedHelpers = {
      init_corpus,
      init_corpus_from_context
    }
    const injectedFunctions = {
      ...toolFunctions,
      ...injectedHelpers
    }
    const toolNames = Object.keys(injectedFunctions)
    const toolValues = Object.values(injectedFunctions)

    if (sandboxMode === "strict") {
      const strictScope = makeStrictScope(
        print,
        __vars,
        llm_query,
        llm_query_batched,
        init_corpus,
        init_corpus_from_context,
        injectedFunctions
      )
      const fn = new AsyncFunction(
        "print",
        "__vars",
        "llm_query",
        "llm_query_batched",
        "init_corpus",
        "init_corpus_from_context",
        "__strictScope",
        ...toolNames,
        `
        with (__strictScope) {
          ${code}
        }
      `
      )
      await fn(
        print,
        __vars,
        llm_query,
        llm_query_batched,
        init_corpus,
        init_corpus_from_context,
        strictScope,
        ...toolValues
      )
    } else {
      const fn = new AsyncFunction(
        "print",
        "__vars",
        "llm_query",
        "llm_query_batched",
        "init_corpus",
        "init_corpus_from_context",
        ...toolNames,
        code
      )
      await fn(
        print,
        __vars,
        llm_query,
        llm_query_batched,
        init_corpus,
        init_corpus_from_context,
        ...toolValues
      )
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

      // Create tool bridge functions from tool descriptors
      toolFunctions = {}
      const jsIdentifierRe = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
      const reservedBindings = new Set([
        "print",
        "__vars",
        "llm_query",
        "llm_query_batched",
        "init_corpus",
        "init_corpus_from_context",
        "__strictScope"
      ])
      if (Array.isArray(msg.tools)) {
        for (const tool of msg.tools) {
          const toolName = String(tool.name)
          if (!jsIdentifierRe.test(toolName) || reservedBindings.has(toolName)) {
            console.error(`[sandbox-worker] Skipping invalid tool name: ${toolName}`)
            continue
          }
          toolFunctions[toolName] = async (...args: unknown[]): Promise<unknown> => {
            if (sandboxMode === "strict") {
              throw new Error("Bridge disabled in strict sandbox mode")
            }
            const bridgeRequestId = crypto.randomUUID()
            return new Promise((resolve, reject) => {
              pendingBridge.set(bridgeRequestId, { resolve, reject })
              safeSend({
                _tag: "BridgeCall",
                requestId: bridgeRequestId,
                method: toolName,
                args
              })
            })
          }
        }
      }

      console.error(`[sandbox-worker] Init: callId=${workerCallId} depth=${workerDepth} mode=${sandboxMode} maxFrameBytes=${maxFrameBytes} tools=${Object.keys(toolFunctions).join(",")}`)
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

    case "ListVarsRequest": {
      const requestId = String(msg.requestId)

      const buildPreview = (value: unknown): { type: string; size?: number; preview: string } => {
        if (value === null) return { type: "null", preview: "null" }
        if (value === undefined) return { type: "undefined", preview: "undefined" }

        if (typeof value === "string") {
          return {
            type: "string",
            size: value.length,
            preview: value.length > 200 ? value.slice(0, 200) + "..." : value
          }
        }

        if (Array.isArray(value)) {
          return {
            type: "array",
            size: value.length,
            preview: `Array(${value.length})`
          }
        }

        if (typeof value === "object") {
          const keys = Object.keys(value as object)
          return {
            type: "object",
            size: keys.length,
            preview: `{${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}}`
          }
        }

        if (typeof value === "function") {
          const fn = value as Function
          return {
            type: "function",
            preview: `[Function ${fn.name || "anonymous"}]`
          }
        }

        return {
          type: typeof value,
          preview: String(value).slice(0, 200)
        }
      }

      const variables = Array.from(vars.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => {
          const { type, size, preview } = buildPreview(value)
          return {
            name,
            type,
            ...(size !== undefined ? { size } : {}),
            preview
          }
        })

      safeSend({ _tag: "ListVarsResult", requestId, variables })
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
      toolFunctions = {}
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
