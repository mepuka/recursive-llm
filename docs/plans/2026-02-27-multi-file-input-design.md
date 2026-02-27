# Multi-File Input: Filesystem-First Design

**Date:** 2026-02-27
**Status:** Approved

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

**Naming rules:** Same as existing `--media` flag. If `=` is present, the left side is the logical name. Otherwise, the basename without extension becomes the name. Duplicate names are a CLI validation error.

**Removed:** `--context-file` is removed. Migration: `--context-file foo.json` becomes `--input context=foo.json` or `--input foo.json`.

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
- At least one of `context` or `inputs` should be present.
- `contextMetadata` applies only to inline `context`. Each input carries its own metadata.

### Data Flow

```
CLI (--input users=data/users.ndjson --input posts=data/posts.ndjson)
  │
  ├─ Normalize.ts: parse --input specs into InputFile[] (path + name)
  │
  ├─ Run.ts: for each InputFile, run analyzeContext(file contents prefix)
  │          to detect format/fields/recordCount. Don't read full file.
  │
  ├─ Rlm.stream({ query, inputs: [...], context?: "..." })
  │
  ├─ Scheduler handleStartCall:
  │    1. Copy each input file into sandbox working directory
  │       (e.g., /tmp/rlm-sandbox-root-xxx/users.ndjson)
  │    2. Inject __vars.inputs manifest (metadata only, not content):
  │       [
  │         { name: "users", path: "users.ndjson", format: "ndjson",
  │           chars: 15042000, lines: 15000, recordCount: 15000,
  │           fields: ["id","name","email"],
  │           sampleRecord: '{"id":1,"name":"Alice",...}' },
  │         { name: "posts", path: "posts.ndjson", ... }
  │       ]
  │    3. If inline context provided, inject __vars.context as before
  │    4. Inject __vars.query as before
  │
  └─ Sandbox: model accesses files via readFile("users.ndjson")
              or shell("jq '.[] | .name' users.ndjson")
              Metadata available in __vars.inputs
```

**Key property:** File contents never cross the IPC boundary. They're copied at the filesystem level. No frame size limit applies.

### System Prompt Changes

When `inputs` are present, the system prompt adds an "Input Files" section:

```
## Input Files
The following data files are available in your working directory:

| File | Format | Size | Records | Fields |
|------|--------|------|---------|--------|
| users.ndjson | ndjson | 15.0 MB | 15,000 | id, name, email, ... |
| posts.ndjson | ndjson | 8.2 MB | 8,200 | id, author, text, topics |
| schema.md | markdown | 4.2 KB | — | — |

Access with `await readFile("users.ndjson")` or process with shell tools.
File metadata is also available in `__vars.inputs`.

For large files, avoid reading the entire file into a single variable.
Use shell tools, read in chunks, or process line-by-line.
```

The existing "Variable Space" section continues to describe `__vars.context` (if inline context is provided) and `__vars.query`.

### Backward Compatibility

| Before | After | Notes |
|--------|-------|-------|
| `--context "string"` | `--context "string"` | Unchanged |
| `--context-file path` | `--input [name=]path` | Removed, CLI error with migration hint |
| `Rlm.stream({ context: "..." })` | `Rlm.stream({ context: "..." })` | `context` is now optional |
| `__vars.context` | `__vars.context` | Still populated for inline context |
| `__vars.contextMeta` | `__vars.contextMeta` | Still populated for inline context |
| — | `__vars.inputs` | New: array of input file metadata |

### What This Does NOT Change

- **Media attachments** (`--media`, `--media-url`): unchanged. These are for binary blobs sent to multimodal LLM calls, not for sandbox data processing.
- **Sandbox filesystem API** (`readFile`, `writeFile`, `shell`, etc.): unchanged. Input files are just regular files in the working directory.
- **IPC protocol**: unchanged. Only metadata (the `__vars.inputs` manifest) goes through IPC, not file contents.
- **Bridge calls** (`llm_query`, `llm_query_batched`): unchanged.

## Files Modified (Estimated)

| File | Change |
|------|--------|
| `src/cli/Command.ts` | Add `--input` option, remove `--context-file` |
| `src/cli/Normalize.ts` | Parse `--input` specs, remove `contextFile` handling |
| `src/CliLayer.ts` | Update `CliArgs` interface |
| `src/cli/Run.ts` | Analyze input file metadata, pass to Rlm |
| `src/Rlm.ts` | Update `CompleteOptionsBase`, make `context` optional |
| `src/RlmTypes.ts` | Add `InputFile` type, update `CompletionOptions` |
| `src/Scheduler.ts` | Stage files to sandbox dir, inject `__vars.inputs` |
| `src/SystemPrompt.ts` | Add "Input Files" section, update prompting |
| `src/ContextMetadata.ts` | Support partial analysis (first N bytes for large files) |
| `test/CliCommand.test.ts` | Update for new --input flag |
| `test/CliNormalize.test.ts` | Update for --input parsing |
| `test/Scheduler.test.ts` | Test file staging + manifest injection |
| `test/SystemPrompt.test.ts` | Test input files prompt section |
