import * as KeyValueStore from "@effect/platform/KeyValueStore"
import type * as PlatformError from "@effect/platform/Error"
import { Context, Effect, Layer, Option } from "effect"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { ContextMetadata } from "./ContextMetadata"
import { RlmRuntime } from "./Runtime"
import type { FinalAnswerPayload, RlmEvent } from "./RlmTypes"

export interface RunTraceMeta {
  readonly completionId: string
  readonly query: string
  readonly contextChars: number
  readonly contextMetadata?: ContextMetadata
  readonly model: string
  readonly maxIterations: number
  readonly maxLlmCalls: number
  readonly startedAt: string
}

export interface TraceVarSnapshot {
  readonly callId: string
  readonly depth: number
  readonly iteration: number
  readonly vars: Record<string, unknown>
}

export interface RunTraceConfigService {
  readonly enabled: boolean
  readonly baseDir: string
  readonly maxSnapshotBytes: number
}

export interface RunTraceWriterService {
  readonly writeMeta: (meta: RunTraceMeta) => Effect.Effect<void, PlatformError.PlatformError>
  readonly appendEvent: (event: RlmEvent) => Effect.Effect<void, PlatformError.PlatformError>
  readonly writeVarSnapshot: (
    snapshot: TraceVarSnapshot
  ) => Effect.Effect<void, PlatformError.PlatformError>
  readonly writeResult: (
    payload: FinalAnswerPayload
  ) => Effect.Effect<void, PlatformError.PlatformError>
}

export interface RunTraceWriterOptions {
  readonly rootStore: KeyValueStore.KeyValueStore
  readonly varsStore: KeyValueStore.KeyValueStore
  readonly maxSnapshotBytes?: number
}

export interface RunTraceWriterBunOptions {
  readonly baseDir: string
  readonly maxSnapshotBytes: number
}

const DEFAULT_MAX_SNAPSHOT_BYTES = 5_000_000
const META_FILE = "meta.json"
const TRANSCRIPT_FILE = "transcript.ndjson"
const RESULT_FILE = "result.json"
const TRUNCATED_SENTINEL_KEY = "__trace_truncated__"
const textEncoder = new TextEncoder()

const byteLength = (value: string): number =>
  textEncoder.encode(value).byteLength

const safePathToken = (value: string): string => {
  const token = value.replace(/[^a-zA-Z0-9._-]/g, "-")
  return token.length > 0 ? token : "unknown"
}

const makeSafeReplacer = () => {
  const seen = new WeakSet<object>()
  return (_key: string, value: unknown): unknown => {
    if (value === undefined) return "(undefined)"
    if (typeof value === "bigint") return `${value}n`
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
    if (typeof value === "symbol") return value.toString()

    if (value instanceof Error) {
      return {
        _tag: value.name,
        message: value.message,
        ...(value.stack !== undefined ? { stack: value.stack } : {})
      }
    }

    if (value instanceof Map) {
      return {
        _tag: "Map",
        entries: Array.from(value.entries())
      }
    }

    if (value instanceof Set) {
      return {
        _tag: "Set",
        values: Array.from(value.values())
      }
    }

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "(circular)"
      seen.add(value)
    }

    return value
  }
}

const safeJsonStringify = (value: unknown): string => {
  try {
    const serialized = JSON.stringify(value, makeSafeReplacer())
    return serialized !== undefined
      ? serialized
      : "\"(undefined)\""
  } catch {
    return "\"(serialization failed)\""
  }
}

const normalizeUnknown = (value: unknown): unknown => {
  try {
    return JSON.parse(safeJsonStringify(value))
  } catch {
    return "(serialization failed)"
  }
}

const buildEventLine = (event: RlmEvent): string => {
  const normalized = normalizeUnknown(event)
  const payload = typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)
    ? {
        loggedAt: new Date().toISOString(),
        ...(normalized as Record<string, unknown>)
      }
    : {
        loggedAt: new Date().toISOString(),
        event: normalized
      }
  return safeJsonStringify(payload)
}

const buildSnapshotKey = (snapshot: TraceVarSnapshot): string => {
  const iteration = String(Math.max(0, Math.trunc(snapshot.iteration))).padStart(3, "0")
  const depth = Math.max(0, Math.trunc(snapshot.depth))
  const callId = safePathToken(snapshot.callId)
  return `call-${callId}.depth-${depth}.iter-${iteration}.json`
}

const buildSnapshotPayload = (
  snapshot: TraceVarSnapshot,
  maxSnapshotBytes: number
): string => {
  const sorted = Object.entries(snapshot.vars).sort(([a], [b]) => a.localeCompare(b))
  const vars: Record<string, unknown> = {}
  const base = {
    callId: snapshot.callId,
    depth: snapshot.depth,
    iteration: snapshot.iteration
  }

  let truncated = false
  for (const [name, rawValue] of sorted) {
    vars[name] = normalizeUnknown(rawValue)
    const candidate = safeJsonStringify({ ...base, vars })
    if (byteLength(candidate) > maxSnapshotBytes) {
      delete vars[name]
      truncated = true
      break
    }
  }

  if (truncated) {
    vars[TRUNCATED_SENTINEL_KEY] = `Snapshot exceeded ${maxSnapshotBytes} bytes`
  }

  let payload = safeJsonStringify({ ...base, vars })
  if (byteLength(payload) > maxSnapshotBytes) {
    payload = safeJsonStringify({
      ...base,
      vars: {
        [TRUNCATED_SENTINEL_KEY]: `Snapshot exceeded ${maxSnapshotBytes} bytes`
      }
    })
  }

  return payload
}

const makeNoopWriter = (): RunTraceWriterService => ({
  writeMeta: () => Effect.void,
  appendEvent: () => Effect.void,
  writeVarSnapshot: () => Effect.void,
  writeResult: () => Effect.void
})

export const RunTraceWriterNoopService: RunTraceWriterService = makeNoopWriter()

export class RunTraceWriter extends Context.Reference<RunTraceWriter>()(
  "@recursive-llm/RunTraceWriter",
  {
    defaultValue: makeNoopWriter
  }
) {}

export class RunTraceConfig extends Context.Reference<RunTraceConfig>()(
  "@recursive-llm/RunTraceConfig",
  {
    defaultValue: (): RunTraceConfigService => ({
      enabled: false,
      baseDir: ".rlm/traces",
      maxSnapshotBytes: DEFAULT_MAX_SNAPSHOT_BYTES
    })
  }
) {}

export const RunTraceWriterNoopLayer: Layer.Layer<RunTraceWriter> = Layer.succeed(
  RunTraceWriter,
  RunTraceWriterNoopService
)

export const makeRunTraceWriter = ({
  rootStore,
  varsStore,
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES
}: RunTraceWriterOptions): RunTraceWriterService => ({
  writeMeta: (meta) =>
    rootStore.set(META_FILE, safeJsonStringify(meta)),

  appendEvent: (event) => {
    const line = buildEventLine(event)
    return rootStore.modify(
      TRANSCRIPT_FILE,
      (existing) =>
        existing.length > 0
          ? `${existing}\n${line}`
          : line
    ).pipe(
      Effect.flatMap((updated) =>
        Option.isSome(updated)
          ? Effect.void
          : rootStore.set(TRANSCRIPT_FILE, line))
    )
  },

  writeVarSnapshot: (snapshot) =>
    varsStore.set(
      buildSnapshotKey(snapshot),
      buildSnapshotPayload(snapshot, maxSnapshotBytes)
    ),

  writeResult: (payload) =>
    rootStore.set(RESULT_FILE, safeJsonStringify(payload))
})

export const RunTraceWriterMemory: Layer.Layer<RunTraceWriter> = Layer.effect(
  RunTraceWriter,
  Effect.gen(function*() {
    const rootStore = yield* Effect.provide(
      KeyValueStore.KeyValueStore,
      KeyValueStore.layerMemory
    )
    const varsStore = yield* Effect.provide(
      KeyValueStore.KeyValueStore,
      KeyValueStore.layerMemory
    )
    return makeRunTraceWriter({ rootStore, varsStore })
  })
)

export const RunTraceWriterBun = (
  options: RunTraceWriterBunOptions
): Layer.Layer<RunTraceWriter, never, RlmRuntime> =>
  Layer.effect(
    RunTraceWriter,
    Effect.gen(function*() {
      const runtime = yield* RlmRuntime
      const runDirectory = path.join(options.baseDir, runtime.completionId)
      const varsDirectory = path.join(runDirectory, "vars")

      return yield* Effect.gen(function*() {
        const fsWrite = <A>(
          operation: () => Promise<A>
        ): Effect.Effect<A, PlatformError.PlatformError> =>
          Effect.tryPromise({
            try: operation,
            catch: (error) => error as PlatformError.PlatformError
          })

        yield* fsWrite(() => mkdir(varsDirectory, { recursive: true }))

        return {
          writeMeta: (meta) =>
            fsWrite(() =>
              writeFile(path.join(runDirectory, META_FILE), safeJsonStringify(meta))
            ).pipe(Effect.asVoid),
          appendEvent: (event) =>
            fsWrite(() =>
              appendFile(path.join(runDirectory, TRANSCRIPT_FILE), `${buildEventLine(event)}\n`)
            ).pipe(Effect.asVoid),
          writeVarSnapshot: (snapshot) =>
            fsWrite(() =>
              writeFile(
                path.join(varsDirectory, buildSnapshotKey(snapshot)),
                buildSnapshotPayload(snapshot, options.maxSnapshotBytes)
              )
            ).pipe(Effect.asVoid),
          writeResult: (payload) =>
            fsWrite(() =>
              writeFile(path.join(runDirectory, RESULT_FILE), safeJsonStringify(payload))
            ).pipe(Effect.asVoid)
        } satisfies RunTraceWriterService
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            yield* Effect.logDebug(
              `Run trace initialization failed; tracing disabled for this run: ${String(error)}`
            )
            return RunTraceWriterNoopService
          })
        )
      )
    })
  )
