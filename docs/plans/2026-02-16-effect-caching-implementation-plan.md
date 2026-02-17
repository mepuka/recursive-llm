# Effect-Native Caching Implementation Plan

Date: 2026-02-16
Base spec: `docs/plans/2026-02-07-rlm-effect-caching-refactor-spec.md`
Branch: `feat/effect-caching-implementation`

## Overview

This plan turns the refactor spec into concrete implementation steps. It covers
Tier A (deterministic in-call memoization) and Tier B (request-local sub-call
cache) as the initial deliverable, with Tier C (model response cache) staged
behind a review checkpoint.

The multi-agent caching review (2026-02-16) confirmed:
- All existing caching/layer wiring is correct — no bugs to fix first.
- No Effect caching primitives (`Cache`, `Effect.cached`, etc.) are used today.
- The AI packages themselves use no Effect-level caching for model calls.
- The main optimization targets are prompt rebuild per iteration and duplicate
  sub-call deduplication.

---

## Step 1: Extend `CallContext` with Precomputed Fields

**File:** `src/CallContext.ts`

Add three readonly fields to the `CallContext` interface:

```ts
// New fields on CallContext
readonly staticSystemPromptArgs: Omit<ReplSystemPromptOptions, "iteration" | "budget">
readonly toolDescriptorsForPrompt?: ReadonlyArray<ToolDescriptorForPrompt>
readonly contextPreview?: string
```

Where `ToolDescriptorForPrompt` is the mapped shape currently built inline at
`Scheduler.ts:557-566`:

```ts
export interface ToolDescriptorForPrompt {
  readonly name: string
  readonly description: string
  readonly parameterNames: ReadonlyArray<string>
  readonly parametersJsonSchema: object
  readonly returnsJsonSchema: object
  readonly usageExamples?: ReadonlyArray<string>
}
```

**Changes to `makeCallContext`:**

Add a new `MakeCallContextOptions` field `staticSystemPromptArgs` and propagate
it into the returned `CallContext`. The `toolDescriptorsForPrompt` and
`contextPreview` fields are derived from existing data and added at construction.

**Why separate from `makeCallContext` options:** The static system prompt args
depend on config values (`maxIterations`, `maxDepth`, `namedModels`, etc.) that
are available in the scheduler but not in `CallContext` construction options. The
scheduler computes them in `handleStartCall` and passes them in.

**Tests:** Unit test `makeCallContext` to verify new fields are stored and
accessible.

---

## Step 2: Precompute Static Prompt Fragments in `handleStartCall`

**File:** `src/Scheduler.ts` — `handleStartCall` (line ~382)

After the existing `makeCallContext` call (line ~407), compute the static
portions of the system prompt arguments and tool descriptors. Store them on the
`CallContext` created above.

**Current code that moves (lines 557-604):**

The tool descriptor mapping and the system prompt option assembly currently live
inside `handleGenerateStep`. The *static* portions (everything except
`iteration`, `budget.iterationsRemaining`, `budget.llmCallsRemaining`,
`budget.tokenBudgetRemaining`, `budget.totalTokensUsed`, `budget.elapsedMs`)
should be computed once.

**Concretely:**

```ts
// In handleStartCall, after makeCallContext:
const toolDescriptorsForPrompt = state.tools?.map((t) => ({
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
  ...(state.mediaAttachments !== undefined
    ? { mediaNames: state.mediaAttachments.map((a) => a.name) }
    : {}),
  ...(toolDescriptorsForPrompt !== undefined && toolDescriptorsForPrompt.length > 0
    ? { tools: toolDescriptorsForPrompt }
    : {}),
  ...(state.outputJsonSchema !== undefined
    ? { outputJsonSchema: state.outputJsonSchema }
    : {}),
  ...(state.contextMetadata !== undefined
    ? { contextMetadata: state.contextMetadata }
    : {}),
  maxFrameBytes: sandboxConfig.maxFrameBytes,
  sandboxMode: sandboxConfig.sandboxMode,
  ...(config.subModelContextChars !== undefined
    ? { subModelContextChars: config.subModelContextChars }
    : {})
}
```

Then store `staticSystemPromptArgs` and `toolDescriptorsForPrompt` on the
`CallContext`.

**Changes to `handleGenerateStep`:**

Replace the inline computation (lines 557-604) with a merge of the cached
static args and the per-iteration dynamic args:

```ts
const prompt = buildReplPrompt({
  systemPrompt: buildReplSystemPrompt({
    ...callState.staticSystemPromptArgs,
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
    }
  }),
  // ... rest unchanged
})
```

**Remove the `analyzeContext` fallback** at line 607. Since `contextMetadata` is
always set in `handleStartCall` (line 405), the fallback
`callState.contextMetadata ?? analyzeContext(callState.context)` is dead code.
If `contextMetadata` is undefined it means context was empty, in which case the
field is simply omitted.

**Tests:** Existing `Scheduler.test.ts` tests must continue passing (no
behavioral change). Add a focused test that verifies `callState` contains the
precomputed fields after `StartCall`.

---

## Step 3: Add Cache Config to `RlmConfigService`

**File:** `src/RlmConfig.ts`

Extend `RlmConfigService` with:

```ts
readonly cache?: {
  readonly enabled?: boolean                   // default true
  readonly subcallCacheCapacity?: number        // default 256
  readonly subcallCacheTtlMs?: number           // default Duration.infinity (request-local)
  readonly modelCacheCapacity?: number          // default 128
  readonly modelCacheTtlMs?: number             // default Duration.infinity (request-local)
  readonly deterministicOnly?: boolean          // default true
}
```

The `cache` field is optional with all sub-fields optional, preserving
backward compatibility. Defaults are applied in the consumer code.

**CLI integration** (`src/CliLayer.ts`):
- Add `--cache` / `--no-cache` flag (maps to `cache.enabled`).
- No other CLI flags initially — capacity/TTL are internal tuning knobs.

**Tests:** Config parsing test with and without cache field.

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
  readonly keyHash: string
}
CacheMiss: {
  readonly completionId: string
  readonly callId: CallId
  readonly depth: number
  readonly kind: "subcall" | "model"
  readonly keyHash: string
}
```

**File:** `src/RlmRenderer.ts`

Add rendering for these events in verbose mode (log line with hit/miss, kind,
and abbreviated key hash).

**Tests:** Renderer test for new event types.

---

## Step 5: Implement Sub-call Cache (Tier B)

This is the highest-value change: deduplicating identical `llm_query` bridge
calls within a single completion.

### 5a: Add `subcallCache` to `RlmRuntimeShape`

**File:** `src/Runtime.ts`

```ts
import { Cache, Duration } from "effect"

export interface RlmRuntimeShape {
  // ... existing fields ...
  readonly subcallCache: Cache.Cache<string, string, RlmError> | null
}
```

In `RlmRuntimeLive`, create the cache based on config:

```ts
const cacheConfig = config.cache
const subcallCache = cacheConfig?.enabled !== false
  ? yield* Cache.make({
      capacity: cacheConfig?.subcallCacheCapacity ?? 256,
      timeToLive: Duration.millis(cacheConfig?.subcallCacheTtlMs ?? Number.MAX_SAFE_INTEGER),
      lookup: (_key: string) => Effect.die("Cache lookup should not be called directly")
    })
  : null
```

**Note:** The `lookup` function is a dead path — we use `cache.set` + `cache.getOption`
pattern instead of `cache.get`, because the actual computation (sub-call
execution) is orchestrated by the scheduler, not by the cache lookup. An
alternative is to use `cache.get` with a lookup that runs the sub-call, but
that would require restructuring the scheduler's fork-and-deferred pattern.

**Revised approach:** Actually, `Cache.get` with single-flight semantics is
exactly what we want for concurrent dedup. The lookup function should be the
sub-call execution itself. However, the sub-call is deeply interleaved with
the scheduler command queue (it enqueues `StartCall`, waits for `Finalize`).
This makes it impractical to wrap in a Cache lookup.

**Final approach: manual dedup with `getOption` + `set`.**

```ts
// When a sub-call completes (Finalize), store result:
if (subcallCache !== null) {
  yield* subcallCache.set(cacheKey, resultText)
}

// Before starting a sub-call (HandleBridgeCall), check cache:
if (subcallCache !== null) {
  const cached = yield* subcallCache.getOption(cacheKey)
  if (Option.isSome(cached)) {
    yield* publishEvent(RlmEvent.CacheHit({ ... }))
    yield* resolveBridgeDeferred(command.bridgeRequestId, cached.value)
    return
  }
  yield* publishEvent(RlmEvent.CacheMiss({ ... }))
}
```

Wait — `Cache` does not have a `getOption` that skips the lookup. Let me check.
Per the Effect docs research: `Cache.getOption` returns `Option.none` if not
present (no compute), `Cache.getOptionComplete` returns only if completed.
`Cache.getOption` IS what we want.

Actually, per the Effect docs agent's findings: `getOption` DOES trigger the
lookup. The non-triggering variant is `getOptionComplete`. Let me re-check...

The agent reported: "`getOption(key)` — Get if exists, else `None` (no compute)".
And separately: `get(key)` triggers the lookup. So `getOption` is safe.

**Final approach confirmed:** Use `Cache.make` with a no-op lookup, then use
`getOption` (no-compute read) + `set` (manual write on completion).

### 5b: Define the Cache Key

**File:** `src/scheduler/CacheKey.ts` (new file)

```ts
import { Hash } from "effect"

export interface SubcallCacheKeyParts {
  readonly completionId: string
  readonly parentCallId: string
  readonly method: string
  readonly query: string
  readonly context: string
  readonly depth: number
  readonly modelRoute: string // "primary" | "sub" | named model name
}

export const makeSubcallCacheKey = (parts: SubcallCacheKeyParts): string => {
  // Use a stable JSON serialization + hash for the key
  const raw = JSON.stringify([
    parts.completionId,
    parts.parentCallId,
    parts.method,
    parts.query,
    parts.context,
    parts.depth,
    parts.modelRoute
  ])
  return `subcall:${Bun.hash(raw).toString(36)}`
}
```

Using `Bun.hash` (wyhash, very fast) for the key. The stringified array ensures
deterministic ordering. Including `parentCallId` provides frame-scoping by
default (identical queries in different recursion branches produce different
keys).

### 5c: Integrate into `handleHandleBridgeCall`

**File:** `src/Scheduler.ts` — `handleHandleBridgeCall`

For the `llm_query` path (line ~1195), before the depth check and sub-call
dispatch:

```ts
// Cache check for one-shot sub-calls
if (subcallCache !== null && command.method === "llm_query") {
  const modelRoute = (callState.depth + 1 >= config.maxDepth || namedModel !== undefined)
    ? (namedModel ?? (useSubModel(callState.depth + 1) ? "sub" : "primary"))
    : "recursive"
  const cacheKey = makeSubcallCacheKey({
    completionId: runtime.completionId,
    parentCallId: command.callId,
    method: "llm_query",
    query: llmQueryArg,
    context: llmContextArg ?? "",
    depth: callState.depth + 1,
    modelRoute
  })
  const cached = yield* subcallCache.getOption(cacheKey)
  if (Option.isSome(cached)) {
    yield* publishEvent(RlmEvent.CacheHit({ ... }))
    yield* resolveBridgeDeferred(command.bridgeRequestId, cached.value)
    return
  }
  yield* publishEvent(RlmEvent.CacheMiss({ ... }))
  // Store cacheKey on a side channel so Finalize/one-shot completion can write back
}
```

For cache write-back: when a one-shot sub-call completes (in the `.flatMap`
after `runOneShotSubCall`), write the result to the cache. For recursive
sub-calls, write back in `handleFinalize` when `parentBridgeRequestId` is set.

**Threading the cache key:** Add an optional `cacheKey?: string` field to the
`StartCall` command and the one-shot fork closure. This avoids recomputing the
key at write-back time.

### 5d: Cache Write-back Points

**One-shot path** (inside `handleHandleBridgeCall`, after `runOneShotSubCall`):

```ts
const oneShotResult = yield* runOneShotSubCall({ ... })
if (subcallCache !== null && cacheKey !== undefined) {
  yield* subcallCache.set(cacheKey, typeof oneShotResult === "string" ? oneShotResult : JSON.stringify(oneShotResult))
}
yield* resolveBridgeDeferred(command.bridgeRequestId, oneShotResult)
```

**Recursive path** (in `handleFinalize`, when resolving parent bridge deferred):

```ts
if (callState.parentBridgeRequestId) {
  const answer = renderSubmitAnswer(command.payload)
  if (subcallCache !== null && callState.cacheKey !== undefined) {
    yield* subcallCache.set(callState.cacheKey, answer)
  }
  yield* resolveBridgeDeferred(callState.parentBridgeRequestId, answer)
}
```

This requires adding `cacheKey?: string` to `CallContext`.

**Tests:**
- Test that identical `llm_query` calls in the same completion produce a cache
  hit on the second call (fake model receives only one call).
- Test that cache is not shared across completions (separate `Layer.fresh`
  runtimes).
- Test that `--no-cache` disables the cache (two identical calls = two model
  calls).
- Test that different `(query, context)` pairs produce different cache entries.

---

## Step 6: Review Checkpoint

At this point, pause and verify:

1. All 124+ existing tests pass.
2. New cache tests pass.
3. `bun run rlm` works end-to-end with both `--cache` (default) and `--no-cache`.
4. Cache events render correctly in verbose output.

Run codex review: `codex review --uncommitted`

---

## Step 7 (Deferred): Model Response Cache (Tier C)

Contingent on Step 6 review passing. Adds `Cache.Cache<string, GenerateTextResponse>` to the runtime, wrapping all `llmCall.generateText` invocations.

Key design decisions:
- Only cache when `deterministicOnly` is true (default) — temperature 0 or
  equivalent.
- Cache key = hash of serialized prompt + model route + settings.
- Write-back after successful `generateText` response.
- Budget still consumed on cache hit (tokens already counted on first call).
  Or: skip budget consumption on hit and log saved tokens. TBD at review.

This step is deferred because:
- It has higher correctness risk (prompt serialization must be stable).
- The sub-call cache (Tier B) captures the most impactful dedup.
- It requires deciding the budget-on-hit policy.

---

## File Change Summary

| File | Change |
|------|--------|
| `src/CallContext.ts` | Add `staticSystemPromptArgs`, `toolDescriptorsForPrompt`, `contextPreview`, `cacheKey` fields |
| `src/RlmConfig.ts` | Add optional `cache` config block |
| `src/RlmTypes.ts` | Add `CacheHit`, `CacheMiss` event variants |
| `src/Runtime.ts` | Add `subcallCache` to `RlmRuntimeShape`, init in `RlmRuntimeLive` |
| `src/Scheduler.ts` | Precompute static args in `handleStartCall`; use cached args in `handleGenerateStep`; cache check/write in `handleHandleBridgeCall` and `handleFinalize` |
| `src/scheduler/CacheKey.ts` | New: `makeSubcallCacheKey` helper |
| `src/RlmRenderer.ts` | Render `CacheHit`/`CacheMiss` events |
| `src/CliLayer.ts` | Add `--cache`/`--no-cache` CLI flag |
| `test/Scheduler.test.ts` | New cache hit/miss/disabled tests |
| `test/CallContext.test.ts` | Test precomputed field storage |

---

## Implementation Order

```
Step 1  ──► Step 2  ──► Step 3  ──► Step 4  ──► Step 5a ──► Step 5b ──► Step 5c ──► Step 5d ──► Step 6
(types)    (scheduler) (config)    (events)    (runtime)   (key)      (read)      (write)     (review)
```

Steps 3 and 4 can be done in parallel since they touch different files.
Steps 5a and 5b can be done in parallel.

---

## Risks and Constraints

**Cache.getOption semantics:** Must verify that `Cache.getOption` does NOT
trigger the lookup function. If it does, we need an alternative approach
(e.g., a parallel `Ref<Map>` as a simple lookup table, or use
`getOptionComplete`). The Effect docs agent confirmed `getOption` is
non-triggering, but this should be verified with a unit test before building
on it.

**`Bun.hash` stability:** `Bun.hash` uses wyhash which is stable within a
process but not across Bun versions. This is fine for request-local caching
(lifetime = one completion). For Tier D (cross-run), we would need a stable
hash (SHA-256 or similar).

**Memory pressure:** With capacity 256 and string values (LLM responses can
be 1-10KB), worst case is ~2.5MB per completion. Acceptable.

**Budget accounting on cache hit:** A cache hit in the sub-call path should
NOT consume an LLM call from the budget (the call was already counted on the
original execution). The cache check happens before `runOneShotSubCall` or
`StartCall`, so no budget is consumed. This is correct by construction.
