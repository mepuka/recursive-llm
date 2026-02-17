# Effect-Native Caching Implementation Plan (Rev 4)

Date: 2026-02-16
Base spec: `docs/plans/2026-02-07-rlm-effect-caching-refactor-spec.md`
Branch: `feat/effect-caching-implementation`
Revision: 4 — addresses codex review findings from Rev 3

## Review Findings Addressed

### Rev 1 → Rev 2

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | HIGH | Structured `llm_query` results corrupted by `Cache<string, string>` | Cache value type is `unknown`, preserving typed objects |
| 2 | HIGH | `getOption + set` does not dedupe concurrent sub-calls | Deferred-based in-flight map provides single-flight semantics |
| 3 | HIGH | Cache key missing `responseFormat` schema/options | Key now includes schema hash and model override |
| 4 | MEDIUM | Tier A under-delivers on system prompt hotspot | Split `buildReplSystemPrompt` into static prefix + dynamic suffix |
| 5 | MEDIUM | CLI integration point references wrong file | Fixed: flags in `src/cli/Command.ts`, mapping in `src/cli/Normalize.ts` |
| 6 | MEDIUM | `contextPreview` and `toolDescriptorsForPrompt` redundant | Dropped both; tool descriptors embedded in `staticSystemPromptArgs` |
| 7 | LOW | `lookup: Effect.die(...)` is a latent defect | Replaced `Cache` with `Ref<Map<string, Deferred>>` — no `Cache` API |

### Rev 2 → Rev 3

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | HIGH | Cache-hit `Deferred.await` blocks scheduler loop → deadlock | Fork await into separate fiber via `Effect.forkIn` |
| 2 | HIGH | `hashSchema` shallow sort — nested schema diffs can collide | Recursive deep-canonicalization before hashing |
| 3 | HIGH | Recursive cache write-back before schema validation → invalid results cached | Move write-back after validation; fail deferred on validation failure |
| 4 | MEDIUM | TOCTOU inconsistency: Step 5c uses `Ref.get`+`Ref.update`, Risks uses `Ref.modify` | Unified to `Ref.modify` throughout Step 5c |
| 5 | MEDIUM | Deferred timeout documented but not in implementation steps | Added `Effect.timeoutFail` wrapper on `Deferred.await` in cache-hit fork |
| 6 | MEDIUM | Missing test cases: deadlock, schema canonicalization, over-capacity | Added to test plan |
| 7 | LOW | Cache key policy partial divergence from base spec | Acknowledged; `parentCallId` + discriminators sufficient for current runtime |

### Rev 3 → Rev 4

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | HIGH | `StartCall` pre-state failure leaves cache deferred unresolved (poisoned key) | Fail cache deferred in `handleStartCall` error handler; evict key from map |
| 2 | MEDIUM | Cache-hit timeout (30s) shorter than bridge timeout (300s) → split outcomes | Derive cache timeout from `bridgeTimeoutMs` (default 300s) instead of independent config |
| 3 | MEDIUM | Timeout path doesn't evict stale inflight entry → poisoned key for completion | On timeout, check `Deferred.isDone`; if still pending, evict key from map |
| 4 | MEDIUM | `canonicalizeJson` undefined handling incorrect (`Object.keys` includes undefined keys) | Filter out `undefined` values explicitly to match `JSON.stringify` semantics |
| 5 | LOW | Missing test cases for StartCall-pre-state failure and timeout eviction | Added to test plan |

---

## Overview

This plan covers Tier A (deterministic in-call memoization) and Tier B
(request-local sub-call cache with concurrent deduplication) as the initial
deliverable, with Tier C (model response cache) staged behind a review
checkpoint.

The multi-agent caching review (2026-02-16) confirmed:
- All existing caching/layer wiring is correct — no bugs to fix first.
- No Effect caching primitives (`Cache`, `Effect.cached`, etc.) are used today.
- The AI packages themselves use no Effect-level caching for model calls.
- The main optimization targets are prompt rebuild per iteration and duplicate
  sub-call deduplication.

---

## Step 1: Extend `CallContext` with Precomputed Fields

**File:** `src/CallContext.ts`

Add fields to the `CallContext` interface:

```ts
// New fields on CallContext
readonly staticSystemPromptArgs: Omit<ReplSystemPromptOptions, "iteration" | "budget">
readonly staticSystemPromptPrefix: string
readonly cacheKey?: string  // set for recursive sub-calls with caching enabled
```

**Dropped from Rev 1:**
- `contextPreview` — unused by current metadata flow (`Scheduler.ts:405`
  always derives metadata; `RlmPrompt.ts:65` prefers metadata over raw preview).
- `toolDescriptorsForPrompt` — redundant; tool descriptors are already
  included inside `staticSystemPromptArgs.tools`.

**Changes to `makeCallContext`:**

Add `staticSystemPromptArgs`, `staticSystemPromptPrefix`, and optional
`cacheKey` to `MakeCallContextOptions` and propagate into the returned
`CallContext`.

**Tests:** Unit test `makeCallContext` to verify the new fields are stored and
accessible.

---

## Step 2: Precompute Static Prompt Fragments in `handleStartCall`

**File:** `src/Scheduler.ts` — `handleStartCall` (line ~382)

After the existing `makeCallContext` call (line ~407), compute the static
portions of the system prompt arguments. Store them on the `CallContext`.

**Current code that moves (lines 557-604):**

The tool descriptor mapping and system prompt option assembly currently live
inside `handleGenerateStep`. The *static* portions (everything except
`iteration` and `budget.*`) are computed once in `handleStartCall`.

**Concretely:**

```ts
// In handleStartCall, after makeCallContext:
const toolDescriptors = command.tools?.map((t) => ({
  name: t.name,
  description: t.description,
  parameterNames: t.parameterNames,
  parametersJsonSchema: t.parametersJsonSchema,
  returnsJsonSchema: t.returnsJsonSchema,
  ...(t.usageExamples !== undefined && t.usageExamples.length > 0
    ? { usageExamples: t.usageExamples }
    : {})
}))

const staticSystemPromptArgs = {
  depth: command.depth,
  maxIterations: config.maxIterations,
  maxDepth: config.maxDepth,
  ...(config.namedModels !== undefined
    ? { namedModelNames: Object.keys(config.namedModels) }
    : {}),
  ...(command.mediaAttachments !== undefined && command.mediaAttachments.length > 0
    ? { mediaNames: command.mediaAttachments.map((a) => a.name) }
    : {}),
  ...(toolDescriptors !== undefined && toolDescriptors.length > 0
    ? { tools: toolDescriptors }
    : {}),
  ...(command.outputJsonSchema !== undefined
    ? { outputJsonSchema: command.outputJsonSchema }
    : {}),
  ...(contextMetadata !== undefined
    ? { contextMetadata }
    : {}),
  maxFrameBytes: sandboxConfig.maxFrameBytes,
  sandboxMode: sandboxConfig.sandboxMode,
  ...(config.subModelContextChars !== undefined
    ? { subModelContextChars: config.subModelContextChars }
    : {})
}
```

Pass `staticSystemPromptArgs` into `makeCallContext`.

### Tier A enhancement: split `buildReplSystemPrompt`

**File:** `src/SystemPrompt.ts`

**Problem (Rev 1 Finding #4):** Even with precomputed args, the full system
prompt string (~750 lines of template) is rebuilt every iteration. Most of
this is static — only the iteration counter, budget snapshot, and phase label
change.

**Feasibility confirmed:** Rev 2 codex review verified that iteration/budget-
dependent logic is localized near `src/SystemPrompt.ts:747`. The split is
clean.

**Solution:** Split `buildReplSystemPrompt` into two functions:

```ts
// Returns the static prefix (everything that doesn't depend on iteration/budget)
export const buildReplSystemPromptStatic = (
  options: Omit<ReplSystemPromptOptions, "iteration" | "budget">
): string => { ... }

// Returns the dynamic suffix (iteration counter, budget, phase)
export const buildReplSystemPromptDynamic = (
  options: Pick<ReplSystemPromptOptions, "iteration" | "budget"> & { maxIterations: number }
): string => { ... }
```

In `handleStartCall`, precompute and store the static prefix:

```ts
const staticSystemPromptPrefix = buildReplSystemPromptStatic(staticSystemPromptArgs)
```

Store `staticSystemPromptPrefix` on the `CallContext`.

**Changes to `handleGenerateStep`:**

Replace the inline computation (lines 557-604) with concatenation:

```ts
const dynamicSuffix = buildReplSystemPromptDynamic({
  iteration: iteration + 1,
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
  maxIterations: config.maxIterations
})

const prompt = buildReplPrompt({
  systemPrompt: callState.staticSystemPromptPrefix + "\n" + dynamicSuffix,
  query: callState.query,
  ...(callState.contextMetadata !== undefined || callState.context.length > 0
    ? { contextMetadata: callState.contextMetadata }
    : {}),
  transcript,
  enablePromptCaching: config.enablePromptCaching
})
```

**Remove the `analyzeContext` fallback** at line 607. Since `contextMetadata` is
always set in `handleStartCall` (line 405), the fallback
`callState.contextMetadata ?? analyzeContext(callState.context)` is dead code.

**Tests:** Existing `Scheduler.test.ts` tests must continue passing (no
behavioral change). Add a focused test that verifies `callState` contains the
precomputed fields and prefix string after `StartCall`.

---

## Step 3: Add Cache Config to `RlmConfigService`

**File:** `src/RlmConfig.ts`

Extend `RlmConfigService` with:

```ts
readonly cache?: {
  readonly enabled?: boolean                   // default true
  readonly subcallCacheCapacity?: number        // default 256
  readonly deterministicOnly?: boolean          // default true
}
```

The `cache` field is optional with all sub-fields optional, preserving
backward compatibility. Defaults are applied in the consumer code.

**No separate cache timeout config.** The cache-hit timeout is derived from
the existing `bridgeTimeoutMs` config (default 300s, see `BridgeHandler.ts:72`)
to ensure cache-hit waiters never time out before the original sub-call would.

Removed from Rev 1: `subcallCacheTtlMs`, `modelCacheCapacity`, `modelCacheTtlMs`
— TTL is unnecessary for request-local lifetime (map lives in `RlmRuntime`
which is `Layer.fresh` per completion). Model cache config deferred to Tier C.

**CLI integration:**

**Flag definition** (`src/cli/Command.ts`):
```ts
const noCache = Options.boolean("no-cache").pipe(
  Options.withDescription("Disable sub-call caching and deduplication")
)
```

Add `noCache` to `commandConfig`.

**Flag mapping** (`src/cli/Normalize.ts`):
```ts
// In normalizeCliArgs:
readonly noCache: boolean
// Maps to:
cache: { enabled: !parsed.noCache }
```

**Downstream consumption** (`src/CliLayer.ts`):
```ts
// In buildRlmConfig:
...(cliArgs.noCache ? { cache: { enabled: false } } : {})
```

**Tests:** Config parsing test with and without cache field. CLI flag test
for `--no-cache`.

---

## Step 4: Add Cache Events to `RlmEvent`

**File:** `src/RlmTypes.ts`

Add two new event variants to the `RlmEvent` tagged enum:

```ts
CacheHit: {
  readonly completionId: string
  readonly callId: CallId
  readonly depth: number
  readonly kind: "subcall" | "model"
  readonly cacheKey: string
}
CacheMiss: {
  readonly completionId: string
  readonly callId: CallId
  readonly depth: number
  readonly kind: "subcall" | "model"
  readonly cacheKey: string
}
```

**File:** `src/RlmRenderer.ts`

Add rendering for these events in verbose mode (log line with hit/miss, kind,
and abbreviated cache key). Handle in `Match.tagsExhaustive` to maintain
exhaustiveness.

**Tests:** Renderer test for new event types.

---

## Step 5: Implement Sub-call Cache (Tier B)

This is the highest-value change: deduplicating identical `llm_query` bridge
calls within a single completion, with proper concurrent single-flight
semantics and typed value preservation.

### Architecture: Deferred-based In-flight Map

**Why not `Cache`:** The Rev 1 codex review identified three problems with the
`Cache.Cache<string, string>` approach:

1. `Cache` value type was `string`, corrupting structured `responseFormat`
   results that are `object | unknown`.
2. `getOption + set` doesn't dedupe concurrent in-flight sub-calls — two
   identical bridge calls arriving before the first completes would both miss.
3. The `lookup: Effect.die(...)` pattern creates a latent defect if anyone
   later calls `Cache.get` or `Cache.refresh`.

**Solution:** Use a `Ref<Map<string, Deferred<unknown, RlmError>>>` instead:

- **First caller** for a given key: creates a `Deferred`, stores it in the
  map, and proceeds with the actual sub-call. On completion, resolves the
  deferred with the result (preserving the original type — `string` or parsed
  `object`).
- **Concurrent callers** with the same key: find the existing `Deferred`,
  **fork** a fiber to await it and resolve the bridge (so the scheduler loop
  continues processing commands).
- **Later callers** after completion: find the already-resolved `Deferred`,
  fork completes immediately.

This gives us concurrent dedup, completed-entry reuse, typed values, and
no `Effect.die` hazards — all without the `Cache` API.

### 5a: Add `SubcallCache` to `RlmRuntimeShape`

**File:** `src/Runtime.ts`

```ts
import { Deferred, Ref } from "effect"
import type { RlmError } from "./RlmError"

export interface SubcallCache {
  readonly inflight: Ref.Ref<Map<string, Deferred.Deferred<unknown, RlmError>>>
  readonly capacity: number
  readonly timeoutMs: number  // derived from bridgeTimeoutMs
}

export interface RlmRuntimeShape {
  // ... existing fields ...
  readonly subcallCache: SubcallCache | null
}
```

In `RlmRuntimeLive`, create the cache based on config:

```ts
const cacheEnabled = config.cache?.enabled !== false
const subcallCache: SubcallCache | null = cacheEnabled
  ? {
      inflight: yield* Ref.make(new Map<string, Deferred.Deferred<unknown, RlmError>>()),
      capacity: config.cache?.subcallCacheCapacity ?? 256,
      timeoutMs: config.bridgeTimeoutMs ?? 300_000  // match bridge timeout
    }
  : null
```

No `Cache.make`, no `Effect.die`, no TTL. The map lives in `RlmRuntime` which
is `Layer.fresh` per completion, so it's automatically scoped to a single run.

### 5b: Define the Cache Key

**File:** `src/scheduler/CacheKey.ts` (new file)

```ts
export interface SubcallCacheKeyParts {
  readonly completionId: string
  readonly parentCallId: string
  readonly method: string       // "llm_query"
  readonly query: string
  readonly context: string
  readonly depth: number
  readonly modelRoute: string   // "primary" | "sub" | named model name
  readonly responseFormatHash?: string  // hash of schema object, if present
}

export const makeSubcallCacheKey = (parts: SubcallCacheKeyParts): string => {
  const raw = JSON.stringify([
    parts.completionId,
    parts.parentCallId,
    parts.method,
    parts.query,
    parts.context,
    parts.depth,
    parts.modelRoute,
    parts.responseFormatHash ?? ""
  ])
  return `subcall:${Bun.hash(raw).toString(36)}`
}

/**
 * Deep-canonicalize a JSON-serializable value for deterministic hashing.
 * Recursively sorts object keys at all nesting levels. Arrays preserve order.
 * Drops keys with `undefined` values to match `JSON.stringify` semantics.
 */
export const canonicalizeJson = (value: unknown): string => {
  if (value === undefined) return "null"  // match JSON.stringify(undefined) → undefined, but treat as null for safety
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeJson).join(",") + "]"
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
  return "{" + keys.map((k) =>
    JSON.stringify(k) + ":" + canonicalizeJson(obj[k])
  ).join(",") + "}"
}

/**
 * Produce a stable hash for a responseFormat schema object.
 * Uses deep canonicalization to ensure nested key ordering is deterministic.
 */
export const hashSchema = (schema: object): string => {
  return Bun.hash(canonicalizeJson(schema)).toString(36)
}
```

**Changes from Rev 1 (Finding #3) and Rev 2 (Finding #2):**
- `hashSchema` now uses `canonicalizeJson` which recursively sorts keys at
  all nesting levels, preventing collisions from nested schema differences.
- Added `responseFormatHash` to key parts — same `(query, context)` with
  different schemas now produce different cache keys.
- `modelRoute` already covers model overrides (named models, sub-model
  routing).
- `parentCallId` provides frame-scoping (sibling branches are distinct).

**Key policy note (Rev 2 Finding #7):** The base spec
(`docs/plans/2026-02-07-rlm-effect-caching-refactor-spec.md:96-108`)
recommends additional discriminators like `framePathHash` and
`systemPromptRevision`. For the current runtime, `parentCallId` + `depth`
achieves the same frame isolation because the call tree is deterministic from
the root. The `systemPromptRevision` discriminator is unnecessary because the
prompt is fixed within a completion. If Tier D (cross-run) caching is added
later, these additional discriminators would be needed.

### 5c: Integrate into `handleHandleBridgeCall`

**File:** `src/Scheduler.ts` — `handleHandleBridgeCall`

For the `llm_query` path (line ~1195), after argument validation but before
the depth check and sub-call dispatch:

```ts
// --- Cache check for llm_query sub-calls ---
let cacheKey: string | undefined
if (subcallCache !== null && command.method === "llm_query") {
  const modelRoute = namedModel
    ?? (callState.depth + 1 >= config.maxDepth ? "oneshot" : "recursive")
  cacheKey = makeSubcallCacheKey({
    completionId: runtime.completionId,
    parentCallId: command.callId,
    method: "llm_query",
    query: llmQueryArg,
    context: llmContextArg ?? "",
    depth: callState.depth + 1,
    modelRoute,
    ...(responseFormat !== undefined
      ? { responseFormatHash: hashSchema(responseFormat.schema) }
      : {})
  })

  // Atomic check-and-insert using Ref.modify to eliminate TOCTOU races
  const freshDeferred = yield* Deferred.make<unknown, RlmError>()
  const cacheResult = yield* Ref.modify(subcallCache.inflight, (m) => {
    const existing = m.get(cacheKey!)
    if (existing !== undefined) {
      return [{ _tag: "hit" as const, deferred: existing }, m] as const
    }
    if (m.size >= subcallCache.capacity) {
      return [{ _tag: "over-capacity" as const }, m] as const
    }
    const next = new Map(m)
    next.set(cacheKey!, freshDeferred)
    return [{ _tag: "miss" as const, deferred: freshDeferred }, next] as const
  })

  if (cacheResult._tag === "hit") {
    yield* publishEvent(RlmEvent.CacheHit({
      completionId: runtime.completionId,
      callId: command.callId,
      depth: callState.depth,
      kind: "subcall",
      cacheKey
    }))

    // CRITICAL (Rev 2 Finding #1): Fork the await into a separate fiber.
    // The scheduler loop MUST NOT block on Deferred.await — otherwise the
    // command queue stalls and the sub-call that would resolve this deferred
    // can never be processed.
    yield* Effect.forkIn(
      Effect.gen(function*() {
        const cachedResult = yield* Deferred.await(cacheResult.deferred).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(subcallCache.timeoutMs),
            onTimeout: () => new SandboxError({
              message: `Sub-call cache await timed out after ${subcallCache.timeoutMs}ms`
            })
          })
        )
        yield* resolveBridgeDeferred(command.bridgeRequestId, cachedResult)
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function*() {
            // CRITICAL (Rev 3 Finding #3): On timeout, evict the stale entry
            // if the deferred is still pending. This prevents a stuck/dropped
            // sub-call from poisoning the key for the rest of the completion.
            const isDone = yield* Deferred.isDone(cacheResult.deferred)
            if (!isDone) {
              yield* evictCacheKey(subcallCache, cacheKey)
            }
            yield* failBridgeDeferred(command.bridgeRequestId, error)
          })
        )
      ),
      callState.callScope
    )
    return
  }

  if (cacheResult._tag === "miss") {
    yield* publishEvent(RlmEvent.CacheMiss({
      completionId: runtime.completionId,
      callId: command.callId,
      depth: callState.depth,
      kind: "subcall",
      cacheKey
    }))
    // Deferred already inserted by Ref.modify above.
    // cacheKey is threaded into sub-call paths below for write-back.
  }
  // "over-capacity" → proceed without caching (no event, no deferred)
}
// ... existing one-shot / recursive dispatch continues below,
//     with cacheKey available for write-back ...
```

**Key changes from Rev 2:**
- **Fork on hit (Finding #1):** `Deferred.await` runs in a forked fiber via
  `Effect.forkIn(..., callState.callScope)`, so the scheduler loop immediately
  returns and continues processing commands. This prevents the deadlock where
  an awaiting hit blocks the scheduler from processing the `StartCall` that
  would resolve the deferred.
- **Timeout (Finding #5):** `Effect.timeoutFail` wraps `Deferred.await` with
  a configurable timeout (default 30s). If a deferred is never resolved (e.g.,
  a sub-call silently drops), the waiter fails with a clear error instead of
  hanging forever.
- **Atomic Ref.modify (Finding #4):** The check-and-insert is done in a single
  `Ref.modify` call. The `Deferred` is created before `Ref.modify`, and either
  inserted (miss) or discarded (hit/over-capacity). This eliminates the TOCTOU
  race between `Ref.get` and `Ref.update`.

**Threading cache key into sub-call paths:**

For one-shot sub-calls: `cacheKey` is captured in the fork closure (already
in scope from the cache check above).

For recursive sub-calls: pass `cacheKey` into the `StartCall` command, then
propagate to `makeCallContext` so it's available on `callState.cacheKey` in
`handleFinalize`.

```ts
// In the recursive dispatch path:
yield* enqueue(RlmCommand.StartCall({
  callId: subCallId,
  depth: callState.depth + 1,
  query: llmQueryArg,
  context: llmContextArg ?? "",
  parentBridgeRequestId: command.bridgeRequestId,
  ...(responseFormat !== undefined ? { outputJsonSchema: responseFormat.schema } : {}),
  ...(cacheKey !== undefined ? { cacheKey } : {})
}))
```

### 5d: Cache Write-back Points

**One-shot path** (inside `handleHandleBridgeCall`, after `runOneShotSubCall`):

```ts
yield* Effect.forkIn(
  Effect.gen(function*() {
    const oneShotResult = yield* runOneShotSubCall({
      query: llmQueryArg,
      context: llmContextArg ?? "",
      depth: callState.depth + 1,
      ...(namedModel !== undefined ? { namedModel } : {}),
      ...(responseFormat !== undefined ? { responseFormat } : {})
    })
    // Cache write-back: resolve deferred with the typed result
    if (subcallCache !== null && cacheKey !== undefined) {
      yield* succeedCacheDeferred(subcallCache, cacheKey, oneShotResult)
    }
    yield* resolveBridgeDeferred(command.bridgeRequestId, oneShotResult)
  }).pipe(
    Effect.catchAllCause((cause) => {
      // On failure, fail the deferred so waiters don't hang
      const error = Cause.isFailType(cause)
        ? (cause.error as RlmError)
        : new SandboxError({ message: Cause.pretty(cause) })
      return Effect.gen(function*() {
        if (subcallCache !== null && cacheKey !== undefined) {
          yield* failCacheDeferred(subcallCache, cacheKey, error)
        }
        const message = "message" in error ? error.message : String(error)
        yield* failBridgeDeferred(command.bridgeRequestId, message)
      })
    })
  ),
  callState.callScope
)
```

**Key property:** `oneShotResult` preserves its original type — `string` for
plain text responses, or the parsed JSON object/array for `responseFormat`
paths (from `parseAndValidateJson` at `Scheduler.ts:980`). The deferred stores
this typed value as `unknown`, and cache hit callers receive it unchanged.

**Helper functions** (defined once in `Scheduler.ts`):

```ts
const succeedCacheDeferred = (
  cache: SubcallCache,
  key: string,
  value: unknown
) =>
  Effect.gen(function*() {
    const m = yield* Ref.get(cache.inflight)
    const deferred = m.get(key)
    if (deferred !== undefined) {
      yield* Deferred.succeed(deferred, value)
    }
  })

const failCacheDeferred = (
  cache: SubcallCache,
  key: string,
  error: RlmError
) =>
  Effect.gen(function*() {
    const m = yield* Ref.get(cache.inflight)
    const deferred = m.get(key)
    if (deferred !== undefined) {
      yield* Deferred.fail(deferred, error)
    }
  })

/**
 * Evict a cache key from the inflight map.
 * Used on timeout (when deferred is still pending) and on StartCall
 * pre-state failure to prevent poisoned keys.
 */
const evictCacheKey = (
  cache: SubcallCache,
  key: string
) =>
  Ref.update(cache.inflight, (m) => {
    const next = new Map(m)
    next.delete(key)
    return next
  })
```

**Recursive path** (in `handleFinalize`, when resolving parent bridge deferred):

**CRITICAL (Rev 2 Finding #3):** Cache write-back MUST happen AFTER schema
validation, not before. If the structured output fails validation, the deferred
must be failed (not resolved with invalid data), so that cache-hit waiters
also receive the error.

```ts
if (callState.parentBridgeRequestId) {
  if (command.payload.source === "answer") {
    // Plain text answer — cache and resolve
    if (subcallCache !== null && callState.cacheKey !== undefined) {
      yield* succeedCacheDeferred(subcallCache, callState.cacheKey, command.payload.answer)
    }
    yield* resolveBridgeDeferred(callState.parentBridgeRequestId, command.payload.answer)
    return
  }

  if (command.payload.source === "value") {
    // Structured output — validate FIRST, then cache
    if (callState.outputJsonSchema !== undefined) {
      const validationResult = validateJsonSchema(command.payload.value, callState.outputJsonSchema)
      if (!validationResult.valid) {
        const error = new OutputValidationError({
          message: `Sub-call structured output schema validation failed: ${validationResult.errors.join("; ")}`,
          raw: renderSubmitAnswer(command.payload)
        })
        // Fail cache deferred so waiters also get the validation error
        if (subcallCache !== null && callState.cacheKey !== undefined) {
          yield* failCacheDeferred(subcallCache, callState.cacheKey, error)
        }
        yield* failBridgeDeferred(callState.parentBridgeRequestId, error)
        return
      }
    }
    // Validation passed (or no schema) — cache the validated value
    if (subcallCache !== null && callState.cacheKey !== undefined) {
      yield* succeedCacheDeferred(subcallCache, callState.cacheKey, command.payload.value)
    }
    yield* resolveBridgeDeferred(callState.parentBridgeRequestId, command.payload.value)
    return
  }

  // Neither "answer" nor "value" — fail
  const error = new OutputValidationError({
    message: "Sub-call finalization must use `SUBMIT({ answer: ... })`.",
    raw: renderSubmitAnswer(command.payload)
  })
  if (subcallCache !== null && callState.cacheKey !== undefined) {
    yield* failCacheDeferred(subcallCache, callState.cacheKey, error)
  }
  yield* failBridgeDeferred(callState.parentBridgeRequestId, error)
}
```

**StartCall pre-state failure** (in `handleStartCall` error handler, `Scheduler.ts:494-508`):

**CRITICAL (Rev 3 Finding #1):** When `handleStartCall` fails before
`setCallState` (e.g., sandbox creation fails, budget exhausted), the cache
deferred — already inserted into the inflight map by the parent's
`handleHandleBridgeCall` — is never resolved. This poisons the key: any
concurrent or future cache hit for the same key will await a deferred that
will never complete (or timeout after `bridgeTimeoutMs`).

**Fix:** In the existing error handler at `Scheduler.ts:494-508`, after
closing the scope and failing the bridge deferred, also fail and evict the
cache deferred:

```ts
// In handleStartCall error handler (Scheduler.ts:494-508):
Effect.gen(function*() {
  yield* Scope.close(callScope, Exit.void)
  if (command.parentBridgeRequestId) {
    yield* failBridgeDeferred(command.parentBridgeRequestId, error)
  }
  // CRITICAL (Rev 3 Finding #1): Fail and evict cache deferred to prevent
  // poisoned key when StartCall fails before setCallState
  if (subcallCache !== null && command.cacheKey !== undefined) {
    yield* failCacheDeferred(subcallCache, command.cacheKey, error)
    yield* evictCacheKey(subcallCache, command.cacheKey)
  }
  yield* enqueue(RlmCommand.FailCall({
    completionId: runtime.completionId,
    callId: command.callId,
    error
  }))
})
```

**Why evict after fail?** Failing the deferred resolves any current waiters
with the error. Evicting the key from the map ensures that *subsequent*
calls for the same key don't find the failed deferred and immediately
receive a stale error — they get a fresh miss instead, which may succeed
if the transient failure (e.g., budget) has been resolved.

**Recursive failure path** (in `handleFailCall`):

```ts
if (callState?.parentBridgeRequestId && callState.cacheKey !== undefined && subcallCache !== null) {
  yield* failCacheDeferred(subcallCache, callState.cacheKey, command.error)
}
```

### Concurrent Dedup Semantics

The deferred-based pattern provides exactly the semantics the base spec
requests (`docs/plans/2026-02-07-rlm-effect-caching-refactor-spec.md:149`):

| Scenario | Behavior |
|----------|----------|
| First call for key K | Miss → create deferred → run sub-call → resolve deferred |
| Concurrent call for key K (in flight) | Hit → **fork** fiber to await deferred → scheduler loop continues |
| Later call for key K (completed) | Hit → fork completes immediately (deferred already resolved) |
| Sub-call fails for key K | Deferred failed → all waiters receive the error |
| Schema validation fails | Deferred failed with `OutputValidationError` → waiters get same error |
| Deferred.await times out | Waiter fails with `SandboxError` → does not affect other waiters |
| Capacity exceeded | No deferred registered → sub-call runs normally (no caching) |

**Budget accounting:** A cache hit does NOT consume an LLM call from the
budget. The cache check happens before `runOneShotSubCall` or `StartCall`
dispatch, so `reserveLlmCall` is never called for cached responses.

**Tests:**
- Identical `llm_query` calls in the same completion produce a cache hit on
  the second call (fake model receives only one call).
- **Concurrent duplicate `llm_query`**: two bridge calls with the same key
  dispatched before either completes → only one model call, both resolve with
  same value.
- **No scheduler deadlock on concurrent hit**: a cache-hit await does NOT
  block the scheduler from processing subsequent commands (including the
  `StartCall` that would resolve the awaited deferred). Test by verifying that
  a recursive sub-call with a concurrent cache hit completes without timeout.
- Structured `responseFormat` cache hit returns typed object/array (not string).
- Same `(query, context)` with different `responseFormat.schema` → different
  cache keys → no false hit.
- Same `(query, context)` with different `options.model` → different cache
  keys → no false hit.
- **Nested schema canonicalization**: schemas `{ a: { x: 1, y: 2 } }` and
  `{ a: { y: 2, x: 1 } }` produce the same hash. Schemas with different
  nested values produce different hashes.
- Cache is not shared across completions (separate `Layer.fresh` runtimes).
- `--no-cache` disables the cache (two identical calls = two model calls).
- Recursive branch isolation: same query in sibling branches (different
  `parentCallId`) → different cache entries.
- `CacheHit`/`CacheMiss` event assertions for both hit/miss paths.
- Sub-call failure with waiters: deferred failed → all waiters receive error.
- **Schema validation failure with waiters**: recursive sub-call with invalid
  structured output → deferred fails with `OutputValidationError` → cache-hit
  waiters receive same validation error.
- **Over-capacity behavior**: when inflight map exceeds capacity, new sub-calls
  proceed without caching (no deferred registered, no events emitted).
- **Timeout on never-resolved deferred**: cache-hit waiter times out with
  `SandboxError` after configured duration.
- **Timeout eviction**: when a cache-hit waiter times out and the deferred is
  still pending (`Deferred.isDone` returns false), the key is evicted from
  the inflight map. A subsequent call for the same key gets a fresh miss.
- **StartCall pre-state failure**: a sub-call whose `StartCall` fails (e.g.,
  sandbox creation error) fails the cache deferred AND evicts the key.
  Concurrent waiters receive the error; subsequent callers get a fresh miss.

---

## Step 6: Review Checkpoint

At this point, pause and verify:

1. All 124+ existing tests pass.
2. New cache tests pass (including concurrent dedup and deadlock tests).
3. `bun run rlm` works end-to-end with both default (cache on) and `--no-cache`.
4. Cache events render correctly in verbose output.
5. Run codex review with full context prompt.

---

## Step 7 (Deferred): Model Response Cache (Tier C)

Contingent on Step 6 review passing. Adds model-level caching wrapping all
`llmCall.generateText` invocations.

Key design decisions:
- Only cache when `deterministicOnly` is true (default) — temperature 0 or
  equivalent.
- Cache key = hash of serialized prompt + model route + settings + schema.
- Same deferred-based pattern as Tier B for concurrent dedup.
- Budget policy: skip budget consumption on hit and log saved tokens.

This step is deferred because:
- It has higher correctness risk (prompt serialization must be stable).
- The sub-call cache (Tier B) captures the most impactful dedup.
- It requires deciding the budget-on-hit policy.

---

## File Change Summary

| File | Change |
|------|--------|
| `src/CallContext.ts` | Add `staticSystemPromptArgs`, `staticSystemPromptPrefix`, `cacheKey` fields |
| `src/SystemPrompt.ts` | Split `buildReplSystemPrompt` into `buildReplSystemPromptStatic` + `buildReplSystemPromptDynamic` |
| `src/RlmConfig.ts` | Add optional `cache` config block (`enabled`, `subcallCacheCapacity`, `deterministicOnly`) |
| `src/RlmTypes.ts` | Add `CacheHit`, `CacheMiss` event variants; add `cacheKey` to `StartCall` command |
| `src/Runtime.ts` | Add `SubcallCache` interface and `subcallCache` to `RlmRuntimeShape` |
| `src/Scheduler.ts` | Precompute static args/prefix in `handleStartCall`; use cached prefix in `handleGenerateStep`; cache check/write in `handleHandleBridgeCall` (forked hit), `handleFinalize` (post-validation write-back), `handleFailCall`, `handleStartCall` error handler (fail+evict cache deferred); add `succeedCacheDeferred`/`failCacheDeferred`/`evictCacheKey` helpers |
| `src/scheduler/CacheKey.ts` | New: `makeSubcallCacheKey`, `canonicalizeJson`, `hashSchema` helpers |
| `src/RlmRenderer.ts` | Render `CacheHit`/`CacheMiss` events |
| `src/cli/Command.ts` | Add `--no-cache` flag definition |
| `src/cli/Normalize.ts` | Map `--no-cache` to config |
| `src/CliLayer.ts` | Consume `noCache` from normalized args |
| `test/Scheduler.test.ts` | New cache tests: hit/miss, concurrent-dedup, no-deadlock, typed values, key discrimination, validation failure, over-capacity, timeout |
| `test/CallContext.test.ts` | Test precomputed field storage |
| `test/scheduler/CacheKey.test.ts` | New: canonicalizeJson determinism, hashSchema collision avoidance |

---

## Implementation Order

```
Step 1  ──► Step 2  ──► Step 3  ──► Step 4  ──► Step 5a ──► Step 5b ──► Step 5c ──► Step 5d ──► Step 6
(types)    (scheduler   (config)    (events)    (runtime)   (key)      (read)      (write)     (review)
            + prompt)
```

Steps 3 and 4 can be done in parallel since they touch different files.
Steps 5a and 5b can be done in parallel.

---

## Risks and Constraints

**Deferred lifecycle:** A `Deferred` that is never resolved (e.g., if the
sub-call silently drops without hitting `handleFinalize` or `handleFailCall`)
would leave waiters hanging. Mitigated by four layers of defense:
1. `Effect.timeoutFail` on `Deferred.await` in the cache-hit fork (derived
   from `bridgeTimeoutMs`, default 300s). On timeout with pending deferred,
   the stale key is evicted from the inflight map.
2. `handleStartCall` error handler: fails cache deferred and evicts key when
   sub-call fails before `setCallState`.
3. The existing `callScope` close in error paths.
4. The completion-level scope close in `Rlm.ts` which interrupts all fibers.

**Deferred double-resolve:** `Deferred.succeed`/`Deferred.fail` on an
already-resolved deferred is a no-op in Effect (returns `false`). This is safe
— if a deferred is resolved by both the write-back path and a timeout/error
path, the second resolution is silently ignored.

**`Bun.hash` stability:** `Bun.hash` uses wyhash which is stable within a
process but not across Bun versions. This is fine for request-local caching
(lifetime = one completion). For Tier D (cross-run), we would need a stable
hash (SHA-256 or similar).

**Memory pressure:** With capacity 256 and `unknown` values (LLM responses can
be 1-10KB), worst case is ~2.5MB per completion. The `Deferred` objects add
negligible overhead. Acceptable.

**Map concurrency and TOCTOU:** All cache check-and-insert operations use
`Ref.modify` for atomicity. The `Deferred` is created before `Ref.modify` and
either inserted (miss) or discarded (hit/over-capacity). If two fibers race
for the same key, only the first one's deferred is inserted; the second sees
the existing entry and awaits it. This eliminates the TOCTOU race entirely.

```ts
// Atomic check-and-insert pattern
const freshDeferred = yield* Deferred.make<unknown, RlmError>()
const result = yield* Ref.modify(subcallCache.inflight, (m) => {
  const existing = m.get(cacheKey)
  if (existing !== undefined) {
    return [{ _tag: "hit" as const, deferred: existing }, m] as const
  }
  if (m.size >= subcallCache.capacity) {
    return [{ _tag: "over-capacity" as const }, m] as const
  }
  const next = new Map(m)
  next.set(cacheKey, freshDeferred)
  return [{ _tag: "miss" as const, deferred: freshDeferred }, next] as const
})
```

**Budget accounting on cache hit:** A cache hit in the sub-call path should
NOT consume an LLM call from the budget (the call was already counted on the
original execution). The cache check happens before `runOneShotSubCall` or
`StartCall`, so no budget is consumed. This is correct by construction.

**Schema canonicalization correctness:** `canonicalizeJson` handles:
- Primitive values (null, boolean, number, string) via `JSON.stringify`
- Arrays (preserve order, recursively canonicalize elements)
- Objects (sort keys at every nesting level, recursively canonicalize values)
- Nested objects within arrays within objects (full recursion)

Edge cases: `undefined` values in objects are explicitly filtered out via
`.filter((k) => obj[k] !== undefined)` after `Object.keys(...).sort()`,
matching `JSON.stringify` behavior (which omits `undefined`-valued keys).
Circular references would cause infinite recursion, but JSON Schema objects
are acyclic by design.
