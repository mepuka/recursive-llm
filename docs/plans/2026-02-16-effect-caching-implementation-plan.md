# Effect-Native Caching Implementation Plan (Rev 2)

Date: 2026-02-16
Base spec: `docs/plans/2026-02-07-rlm-effect-caching-refactor-spec.md`
Branch: `feat/effect-caching-implementation`
Revision: 2 — addresses codex review findings from Rev 1

## Review Findings Addressed

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | HIGH | Structured `llm_query` results corrupted by `Cache<string, string>` | Cache value type is `unknown`, preserving typed objects |
| 2 | HIGH | `getOption + set` does not dedupe concurrent sub-calls | Deferred-based in-flight map provides single-flight semantics |
| 3 | HIGH | Cache key missing `responseFormat` schema/options | Key now includes schema hash and model override |
| 4 | MEDIUM | Tier A under-delivers on system prompt hotspot | Split `buildReplSystemPrompt` into static prefix + dynamic suffix |
| 5 | MEDIUM | CLI integration point references wrong file | Fixed: flags in `src/cli/Command.ts`, mapping in `src/cli/Normalize.ts` |
| 6 | MEDIUM | `contextPreview` and `toolDescriptorsForPrompt` redundant | Dropped both; tool descriptors embedded in `staticSystemPromptArgs` |
| 7 | LOW | `lookup: Effect.die(...)` is a latent defect | Replaced `Cache` with `Ref<Map<string, Deferred>>` — no `Cache` API |

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

Add one readonly field to the `CallContext` interface:

```ts
// New field on CallContext
readonly staticSystemPromptArgs: Omit<ReplSystemPromptOptions, "iteration" | "budget">
```

**Dropped from Rev 1:**
- `contextPreview` — unused by current metadata flow (`Scheduler.ts:405`
  always derives metadata; `RlmPrompt.ts:65` prefers metadata over raw preview).
- `toolDescriptorsForPrompt` — redundant; tool descriptors are already
  included inside `staticSystemPromptArgs.tools`.

**Changes to `makeCallContext`:**

Add `staticSystemPromptArgs` to `MakeCallContextOptions` and propagate into
the returned `CallContext`.

**Tests:** Unit test `makeCallContext` to verify the new field is stored and
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

**Problem (Finding #4):** Even with precomputed args, the full system prompt
string (~750 lines of template) is rebuilt every iteration. Most of this is
static — only the iteration counter, budget snapshot, and phase label change.

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

Add `staticSystemPromptPrefix: string` to `CallContext`.

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

**Why not `Cache`:** The codex review identified three problems with the
Rev 1 `Cache.Cache<string, string>` approach:

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
  await it (in-flight dedup / single-flight semantics).
- **Later callers** after completion: find the already-resolved `Deferred`,
  `Deferred.await` returns immediately (completed-entry reuse).

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
      capacity: config.cache?.subcallCacheCapacity ?? 256
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
 * Produce a stable hash for a responseFormat schema object.
 * Uses JSON.stringify with sorted keys to ensure deterministic ordering.
 */
export const hashSchema = (schema: object): string => {
  const sortedJson = JSON.stringify(schema, Object.keys(schema).sort())
  return Bun.hash(sortedJson).toString(36)
}
```

**Changes from Rev 1 (Finding #3):**
- Added `responseFormatHash` to key parts — same `(query, context)` with
  different schemas now produce different cache keys.
- `modelRoute` already covers model overrides (named models, sub-model
  routing).
- `parentCallId` provides frame-scoping (sibling branches are distinct).

### 5c: Integrate into `handleHandleBridgeCall`

**File:** `src/Scheduler.ts` — `handleHandleBridgeCall`

For the `llm_query` path (line ~1195), after argument validation but before
the depth check and sub-call dispatch:

```ts
// --- Cache check for llm_query sub-calls ---
if (subcallCache !== null && command.method === "llm_query") {
  const modelRoute = namedModel
    ?? (callState.depth + 1 >= config.maxDepth ? "oneshot" : "recursive")
  const cacheKey = makeSubcallCacheKey({
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

  const inflightMap = yield* Ref.get(subcallCache.inflight)

  // Case 1: In-flight or completed — await existing deferred (single-flight)
  const existingDeferred = inflightMap.get(cacheKey)
  if (existingDeferred !== undefined) {
    yield* publishEvent(RlmEvent.CacheHit({
      completionId: runtime.completionId,
      callId: command.callId,
      depth: callState.depth,
      kind: "subcall",
      cacheKey
    }))
    const cachedResult = yield* Deferred.await(existingDeferred)
    yield* resolveBridgeDeferred(command.bridgeRequestId, cachedResult)
    return
  }

  // Case 2: Miss — register deferred before proceeding (if under capacity)
  if (inflightMap.size < subcallCache.capacity) {
    yield* publishEvent(RlmEvent.CacheMiss({
      completionId: runtime.completionId,
      callId: command.callId,
      depth: callState.depth,
      kind: "subcall",
      cacheKey
    }))
    const deferred = yield* Deferred.make<unknown, RlmError>()
    yield* Ref.update(subcallCache.inflight, (m) => {
      const next = new Map(m)
      next.set(cacheKey, deferred)
      return next
    })
    // Thread the cacheKey + deferred into the sub-call path for write-back
  }
}
// ... existing one-shot / recursive dispatch continues below ...
```

**Threading cache key into sub-call paths:**

Add optional `cacheKey?: string` to `CallContext` (for recursive sub-calls)
and to the one-shot fork closure (for one-shot sub-calls). This avoids
recomputing the key at write-back time.

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
      const inflightMap = yield* Ref.get(subcallCache.inflight)
      const deferred = inflightMap.get(cacheKey)
      if (deferred !== undefined) {
        yield* Deferred.succeed(deferred, oneShotResult)
      }
    }
    yield* resolveBridgeDeferred(command.bridgeRequestId, oneShotResult)
  }).pipe(
    Effect.catchAllCause((cause) => {
      // On failure, also fail the deferred so waiters don't hang
      if (subcallCache !== null && cacheKey !== undefined) {
        return Effect.gen(function*() {
          const inflightMap = yield* Ref.get(subcallCache.inflight)
          const deferred = inflightMap.get(cacheKey)
          if (deferred !== undefined) {
            const error = Cause.isFailType(cause)
              ? (cause.error as RlmError)
              : new SandboxError({ message: Cause.pretty(cause) })
            yield* Deferred.fail(deferred, error)
          }
          const message = Cause.isFailType(cause)
            ? ("message" in cause.error ? (cause.error as { message: string }).message : String(cause.error))
            : Cause.pretty(cause)
          yield* failBridgeDeferred(command.bridgeRequestId, message)
        })
      }
      const message = Cause.isFailType(cause)
        ? ("message" in cause.error ? (cause.error as { message: string }).message : String(cause.error))
        : Cause.pretty(cause)
      return failBridgeDeferred(command.bridgeRequestId, message)
    })
  ),
  callState.callScope
)
```

**Key property:** `oneShotResult` preserves its original type — `string` for
plain text responses, or the parsed JSON object/array for `responseFormat`
paths (from `parseAndValidateJson` at `Scheduler.ts:980`). The deferred stores
this typed value as `unknown`, and cache hit callers receive it unchanged.

**Recursive path** (in `handleFinalize`, when resolving parent bridge deferred):

```ts
if (callState.parentBridgeRequestId) {
  // Determine the typed result based on payload source
  const result: unknown = command.payload.source === "value"
    ? command.payload.value
    : renderSubmitAnswer(command.payload)

  // Cache write-back: resolve deferred with typed result
  if (subcallCache !== null && callState.cacheKey !== undefined) {
    const inflightMap = yield* Ref.get(subcallCache.inflight)
    const deferred = inflightMap.get(callState.cacheKey)
    if (deferred !== undefined) {
      yield* Deferred.succeed(deferred, result)
    }
  }

  // Existing bridge resolution logic (unchanged)
  if (command.payload.source === "answer") {
    yield* resolveBridgeDeferred(callState.parentBridgeRequestId, command.payload.answer)
    return
  }
  if (command.payload.source === "value") {
    if (callState.outputJsonSchema !== undefined) {
      const validationResult = validateJsonSchema(command.payload.value, callState.outputJsonSchema)
      if (!validationResult.valid) {
        yield* failBridgeDeferred(
          callState.parentBridgeRequestId,
          new OutputValidationError({ ... })
        )
        return
      }
    }
    yield* resolveBridgeDeferred(callState.parentBridgeRequestId, command.payload.value)
    return
  }
  // ... existing error path ...
}
```

**Recursive failure path** (in `handleFailCall`):

```ts
if (callState?.parentBridgeRequestId && callState.cacheKey !== undefined && subcallCache !== null) {
  const inflightMap = yield* Ref.get(subcallCache.inflight)
  const deferred = inflightMap.get(callState.cacheKey)
  if (deferred !== undefined) {
    yield* Deferred.fail(deferred, command.error)
  }
}
```

### Concurrent Dedup Semantics

The deferred-based pattern provides exactly the semantics the base spec
requests (`docs/plans/2026-02-07-rlm-effect-caching-refactor-spec.md:149`):

| Scenario | Behavior |
|----------|----------|
| First call for key K | Miss → create deferred → run sub-call → resolve deferred |
| Concurrent call for key K (sub-call in flight) | Hit → await same deferred → no duplicate model call |
| Later call for key K (sub-call completed) | Hit → deferred already resolved → immediate return |
| Sub-call fails for key K | Deferred failed → all waiters receive the error |
| Capacity exceeded | No deferred registered → sub-call runs normally (no caching) |

**Budget accounting:** A cache hit does NOT consume an LLM call from the
budget. The cache check happens before `runOneShotSubCall` or `StartCall`
dispatch, so `reserveLlmCall` is never called for cached responses.

**Tests:**
- Identical `llm_query` calls in the same completion produce a cache hit on
  the second call (fake model receives only one call).
- **Concurrent duplicate `llm_query`**: two bridge calls with the same key
  dispatched before either completes → only one model call, both resolve.
- Structured `responseFormat` cache hit returns typed object/array (not string).
- Same `(query, context)` with different `responseFormat.schema` → different
  cache keys → no false hit.
- Same `(query, context)` with different `options.model` → different cache
  keys → no false hit.
- Cache is not shared across completions (separate `Layer.fresh` runtimes).
- `--no-cache` disables the cache (two identical calls = two model calls).
- Recursive branch isolation: same query in sibling branches (different
  `parentCallId`) → different cache entries.
- `CacheHit`/`CacheMiss` event assertions for both hit/miss paths.
- Sub-call failure with waiters: deferred failed → all waiters receive error.

---

## Step 6: Review Checkpoint

At this point, pause and verify:

1. All 124+ existing tests pass.
2. New cache tests pass (including concurrent dedup tests).
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
| `src/RlmConfig.ts` | Add optional `cache` config block |
| `src/RlmTypes.ts` | Add `CacheHit`, `CacheMiss` event variants |
| `src/Runtime.ts` | Add `SubcallCache` interface and `subcallCache` to `RlmRuntimeShape` |
| `src/Scheduler.ts` | Precompute static args/prefix in `handleStartCall`; use cached prefix in `handleGenerateStep`; cache check/write in `handleHandleBridgeCall`, `handleFinalize`, `handleFailCall` |
| `src/scheduler/CacheKey.ts` | New: `makeSubcallCacheKey`, `hashSchema` helpers |
| `src/RlmRenderer.ts` | Render `CacheHit`/`CacheMiss` events |
| `src/cli/Command.ts` | Add `--no-cache` flag definition |
| `src/cli/Normalize.ts` | Map `--no-cache` to config |
| `src/CliLayer.ts` | Consume `noCache` from normalized args |
| `test/Scheduler.test.ts` | New cache hit/miss/concurrent-dedup/disabled tests |
| `test/CallContext.test.ts` | Test precomputed field storage |

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
would leave waiters hanging. This is mitigated by: (a) the existing
`callScope` close in error paths, and (b) the completion-level scope close
in `Rlm.ts` which interrupts all fibers. Add a defensive timeout on
`Deferred.await` in the cache-hit path as a safety net.

**`Bun.hash` stability:** `Bun.hash` uses wyhash which is stable within a
process but not across Bun versions. This is fine for request-local caching
(lifetime = one completion). For Tier D (cross-run), we would need a stable
hash (SHA-256 or similar).

**Memory pressure:** With capacity 256 and `unknown` values (LLM responses can
be 1-10KB), worst case is ~2.5MB per completion. The `Deferred` objects add
negligible overhead. Acceptable.

**Map concurrency:** `Ref.update` on the inflight map is atomic, but there's
a TOCTOU window between `Ref.get` (to check for existing deferred) and
`Ref.update` (to insert a new one). Use `Ref.modify` instead to atomically
check-and-insert:

```ts
const [existingOrNew, _] = yield* Ref.modify(subcallCache.inflight, (m) => {
  const existing = m.get(cacheKey)
  if (existing !== undefined) {
    return [{ _tag: "existing" as const, deferred: existing }, m]
  }
  // Will be populated after Deferred.make — use placeholder approach
  return [{ _tag: "new" as const }, m]
})
```

Actually, since `Deferred.make` is effectful, the atomic pattern requires
creating the deferred first, then using `Ref.modify` to either insert it
or discard it if another fiber beat us:

```ts
const deferred = yield* Deferred.make<unknown, RlmError>()
const result = yield* Ref.modify(subcallCache.inflight, (m) => {
  const existing = m.get(cacheKey)
  if (existing !== undefined) {
    return [{ _tag: "hit" as const, deferred: existing }, m] as const
  }
  if (m.size >= subcallCache.capacity) {
    return [{ _tag: "over-capacity" as const }, m] as const
  }
  const next = new Map(m)
  next.set(cacheKey, deferred)
  return [{ _tag: "miss" as const, deferred }, next] as const
})
```

This eliminates the TOCTOU race entirely. If two fibers race for the same
key, only the first one's deferred is inserted; the second sees the existing
entry and awaits it.

**Budget accounting on cache hit:** A cache hit in the sub-call path should
NOT consume an LLM call from the budget (the call was already counted on the
original execution). The cache check happens before `runOneShotSubCall` or
`StartCall`, so no budget is consumed. This is correct by construction.
