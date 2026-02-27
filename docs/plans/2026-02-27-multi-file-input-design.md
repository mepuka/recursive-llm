# Multi-File Input: Filesystem-First Design

**Date:** 2026-02-27
**Status:** Approved (Rev 2 — addresses code review findings)

## Problem

The RLM CLI accepts a single context source: `--context` (inline string) or `--context-file` (one file path). Both funnel into a single `context: string` field that gets injected into `__vars.context` via IPC.

This creates three problems:
1. **No multi-file support.** Users with separate datasets (users.ndjson + posts.ndjson) must pre-merge externally.
2. **32MB IPC frame limit.** Large files exceed the SetVar frame size and fail silently.
3. **Single-source metadata.** `analyzeContext()` assumes one input, so format detection and field heuristics don't compose across sources.

## Design: Filesystem-First with Input Manifest

### Principle

Files belong on the filesystem. The model already knows `readFile()` and `shell()`. Instead of serializing file contents through IPC, stage files into the sandbox directory and give the model a metadata manifest describing what's available.

### CLI Interface

```bash
# Repeatable --input flag with optional naming
rlm "analyze these datasets" \
  --input users=data/users.ndjson \
  --input posts=data/posts.ndjson \
  --input spec=docs/schema.md

# Auto-naming from basename (no = means use filename stem as name)
rlm "compare these" --input data/report-q3.csv --input data/report-q4.csv

# Inline context still works for simple cases
rlm "summarize this" --context "Some inline text here"

# Combined: inline context + input files
rlm "analyze with instructions" \
  --context "Focus on sentiment" \
  --input corpus=data/articles.ndjson
```

**Naming rules:** Same as existing `--media` flag. If `=` is present, the left side is the logical name. Otherwise, the basename without extension becomes the name. Duplicate logical names are a CLI validation error.

**Hard limits:** Maximum 50 input files and 2 GB total staged bytes per run. Exceeding either is a CLI validation error.

**Validation rules:**
- Each path must point to a regular file (no directories, no device files).
- Symlinks are resolved at validation time and the resolved path must be a regular file.
- Unreadable files produce a deterministic `CliInputError` before the run starts.
- Logical names must match `[A-Za-z][A-Za-z0-9_-]*` (same regex as `--media`).
- Staged filenames are `<logicalName>.<originalExtension>` — if two inputs would produce the same staged filename (e.g., same logical name with different source paths), the duplicate-name check catches it first.

### --context-file Deprecation

`--context-file` is **retained as a deprecated alias** that maps to `--input context=<path>`. When used:
1. The file is staged to the sandbox directory as `context.<ext>` (same as any `--input`).
2. A stderr warning is emitted: `⚠ --context-file is deprecated; use --input instead.`
3. Cannot be combined with an `--input` that also uses the logical name `context`.

This avoids the hard CLI break (finding #2) — @effect/cli still parses the flag, normalize maps it, and users get a clear migration signal.

**Note:** Unlike the old behavior, `--context-file` no longer populates `__vars.context` with file contents. It stages the file to the sandbox directory. This is a behavioral change. The deprecation warning should mention this: `"File is now staged to sandbox directory; use readFile('context.<ext>') to access contents."`

### Programmatic API

```typescript
interface InputFile {
  readonly name: string              // Logical name (e.g., "users")
  readonly path: string              // Filesystem path to source file
  readonly metadata?: ContextMetadata // Pre-computed or auto-detected
}

interface CompleteOptionsBase {
  readonly query: string
  readonly context?: string          // Optional inline context (was required)
  readonly inputs?: ReadonlyArray<InputFile>  // NEW
  readonly contextMetadata?: ContextMetadata  // For inline context only
  readonly mediaAttachments?: ReadonlyArray<MediaAttachment>
  readonly depth?: number
  readonly tools?: ReadonlyArray<RlmToolAny>
  readonly outputJsonSchema?: object
}
```

- `context` becomes optional (`string | undefined`, was required `string`).
- New `inputs` array carries file-based data sources.
- `context`, `inputs`, or both may be provided. Query-only calls (neither context nor inputs) are valid — the model just has no data to work with.
- `contextMetadata` applies only to inline `context`. Each input carries its own metadata.

### Data Flow

```
CLI (--input users=data/users.ndjson --input posts=data/posts.ndjson)
  │
  ├─ Normalize.ts: parse --input specs, resolve symlinks, validate files
  │  exist as regular files, check 50-file/2GB limits
  │
  ├─ Run.ts: for each InputFile, run analyzeContext() on a prefix
  │  read (first 250KB) to detect format/fields/recordCount.
  │  Metadata values from prefix analysis are estimates, marked as such.
  │
  ├─ Rlm.stream({ query, inputs: [...], context?: "..." })
  │
  ├─ Scheduler handleStartCall (ROOT CALL ONLY):
  │    1. Copy each input file into sandbox working directory using
  │       Bun.write(dest, Bun.file(src)) — atomic, no partial files.
  │       Destination: <sandboxDir>/<logicalName>.<originalExtension>
  │    2. Inject __vars.inputs manifest (metadata only, not content).
  │    3. If inline context provided, inject __vars.context as before.
  │    4. Inject __vars.query as before.
  │    NOTE: Sub-calls (recursive depth > 0) inherit the parent's
  │    sandbox directory and do NOT re-stage files.
  │
  └─ Sandbox: model accesses files via readFile("users.ndjson")
              or shell("jq '.[] | .name' users.ndjson")
              Metadata available in __vars.inputs
```

**Key property:** File contents never cross the IPC boundary. They're copied at the filesystem level. The IPC frame limit (32MB) applies only to the `__vars.inputs` manifest, which is lightweight metadata (~1-2KB per file, well under the limit even at 50 files).

### __vars.inputs Manifest Schema

```typescript
// Injected as __vars.inputs — array of InputManifestEntry
interface InputManifestEntry {
  readonly name: string          // Logical name
  readonly path: string          // Relative path in sandbox dir (e.g., "users.ndjson")
  readonly bytes: number         // File size in bytes (exact, from stat)
  readonly format: string        // Detected format: "ndjson" | "json" | "csv" | etc.
  readonly lines: number | null  // Exact line count if file ≤ 250KB, else estimated from prefix. null if unknown.
  readonly linesEstimated: boolean // true if lines was estimated from prefix
  readonly recordCount: number | null  // Exact or estimated record count. null for non-structured.
  readonly recordCountEstimated: boolean
  readonly fields: string[] | null     // Detected field names (first record). null if non-structured.
  readonly sampleRecord: string | null // First record as string (up to 220 chars). null if non-structured.
}
```

**Accuracy contract:** `bytes` is always exact (from `stat`). `lines` and `recordCount` are exact for files where the full content was analyzed (≤ 250KB), and estimated for larger files (derived from the first 250KB prefix). The `*Estimated` boolean flags let the model know when values are approximate. `fields` and `sampleRecord` always come from the first record regardless of file size.

### File Staging Safety

**Atomicity:** Files are copied with `Bun.write(destPath, Bun.file(srcPath))`. If any copy fails, the entire StartCall fails and the sandbox directory is cleaned up by the existing scope cleanup.

**Symlink handling:** Symlinks in `--input` paths are resolved at CLI validation time (`fs.realpathSync`). The resolved path is used for both validation (must be a regular file) and copying. The staged file in the sandbox directory is always a regular file, never a symlink.

**TOCTOU mitigation:** The file is validated (exists, is regular, is readable, size check) at CLI parse time and then copied at StartCall time. If the file changes or disappears between these points, the copy will fail and the error surfaces as a `SandboxError` that terminates the call. This is acceptable — the alternative (locking source files) is impractical for a CLI tool.

**Collision prevention:** Staged filename is `<logicalName>.<extension>`. Since logical names are unique (enforced at CLI validation), and extensions are preserved from the source file, collisions can only occur if two inputs have the same logical name — which is already rejected. If a staged filename collides with a sandbox-internal file (unlikely but possible), the copy overwrites it; sandbox-internal files are ephemeral.

**Root-call only:** File staging happens only for the root call (`depth === 0`). Sub-calls spawned by `llm_query()` inherit the parent's sandbox directory and see the same files. They do NOT re-copy or re-stage.

### System Prompt Changes

When `inputs` are present, the system prompt adds an "Input Files" section:

```
## Input Files
The following data files are available in your working directory:

| File | Format | Size | Records | Fields |
|------|--------|------|---------|--------|
| users.ndjson | ndjson | 15.0 MB | ~15,000 | id, name, email, ... |
| posts.ndjson | ndjson | 8.2 MB | ~8,200 | id, author, text, topics |
| schema.md | markdown | 4.2 KB | — | — |

(Record counts marked ~ are estimated from a file prefix.)

Access with `await readFile("users.ndjson")` or process with shell tools.
File metadata is also available in `__vars.inputs`.

For large files, avoid reading the entire file into a single variable.
Use shell tools, read in chunks, or process line-by-line.
```

**Prompt sanitization:** File names, field names, and sample records are sanitized before interpolation into the system prompt. Specifically:
- Newlines, carriage returns, and backticks are stripped from all metadata strings.
- Field names are truncated to 64 chars each, capped at 24 fields shown.
- Sample records are truncated to 220 chars.
- File names longer than 128 chars are rejected at CLI validation.

The existing "Variable Space" section continues to describe `__vars.context` (if inline context is provided) and `__vars.query`.

### Backward Compatibility

| Before | After | Notes |
|--------|-------|-------|
| `--context "string"` | `--context "string"` | Unchanged |
| `--context-file path` | `--context-file path` | Deprecated alias → `--input context=path`. Stderr warning emitted. File staged to disk, NOT injected into __vars.context. |
| `Rlm.stream({ context: "..." })` | `Rlm.stream({ context: "..." })` | `context` is now optional |
| `__vars.context` | `__vars.context` | Still populated for inline `--context` only |
| `__vars.contextMeta` | `__vars.contextMeta` | Still populated for inline `--context` only |
| — | `__vars.inputs` | New: array of input file metadata |

### What This Does NOT Change

- **Media attachments** (`--media`, `--media-url`): unchanged. These are for binary blobs sent to multimodal LLM calls, not for sandbox data processing.
- **Sandbox filesystem API** (`readFile`, `writeFile`, `shell`, etc.): unchanged. Input files are just regular files in the working directory.
- **IPC protocol**: unchanged. Only the `__vars.inputs` manifest goes through IPC — metadata only, well within frame limits.
- **Bridge calls** (`llm_query`, `llm_query_batched`): unchanged.

## Files Modified (Estimated)

| File | Change |
|------|--------|
| `src/cli/Command.ts` | Add `--input` option, deprecate `--context-file` (keep as alias) |
| `src/cli/Normalize.ts` | Parse `--input` specs with symlink resolution, file validation, size/count limits. Map `--context-file` to `--input context=path` with warning. |
| `src/CliLayer.ts` | Update `CliArgs` interface: add `inputs`, remove `contextFile` (internal only; CLI still accepts the flag) |
| `src/cli/Run.ts` | Analyze input file metadata (prefix read), pass `inputs` to Rlm |
| `src/Rlm.ts` | Update `CompleteOptionsBase`: make `context` optional, add `inputs` |
| `src/RlmTypes.ts` | Add `InputFile`, `InputManifestEntry` types, update `CompletionOptions` |
| `src/Scheduler.ts` | Stage files to sandbox dir (root call only), inject `__vars.inputs` manifest |
| `src/SystemPrompt.ts` | Add "Input Files" section with sanitized metadata table |
| `src/ContextMetadata.ts` | Support partial analysis (first 250KB) with estimated flags |
| `test/CliCommand.test.ts` | Test `--input` parsing, `--context-file` deprecation alias |
| `test/CliNormalize.test.ts` | Test `--input` validation (limits, symlinks, duplicates, malformed specs) |
| `test/Scheduler.test.ts` | Test file staging (root-only), manifest injection, copy failure handling, cleanup |
| `test/SystemPrompt.test.ts` | Test input files prompt section, sanitization |
