import type { ContextMetadata } from "./ContextMetadata"
import { buildSubmitInvocationSchema } from "./SubmitTool"

export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameterNames: ReadonlyArray<string>
  readonly parametersJsonSchema: object
  readonly returnsJsonSchema: object
  readonly usageExamples?: ReadonlyArray<string>
}

export interface ReplSystemPromptOptions {
  readonly depth: number
  readonly iteration: number
  readonly maxIterations: number
  readonly maxDepth: number
  readonly budget: {
    readonly iterationsRemaining: number
    readonly llmCallsRemaining: number
  }
  readonly tools?: ReadonlyArray<ToolDescriptor>
  readonly outputJsonSchema?: object
  readonly sandboxMode?: "permissive" | "strict"
  readonly subModelContextChars?: number
  readonly contextMetadata?: ContextMetadata
}

// Keep this in sync with effect-nlp's exported tool names (currently 19 tools).
const NLP_TOOL_NAMES = new Set([
  "BowCosineSimilarity",
  "ChunkBySentences",
  "CorpusStats",
  "CreateCorpus",
  "DeleteCorpus",
  "DocumentStats",
  "ExtractEntities",
  "ExtractKeywords",
  "LearnCorpus",
  "LearnCustomEntities",
  "NGrams",
  "PhoneticMatch",
  "QueryCorpus",
  "RankByRelevance",
  "Sentences",
  "TextSimilarity",
  "Tokenize",
  "TransformText",
  "TverskySimilarity"
])

const CORE_TEXT_PROCESSING_TOOLS: ReadonlyArray<string> = [
  "DocumentStats",
  "ChunkBySentences",
  "Tokenize",
  "Sentences",
  "TransformText"
]

const ENTITY_AND_PATTERN_TOOLS: ReadonlyArray<string> = [
  "ExtractEntities",
  "LearnCustomEntities"
]

const KEYWORD_AND_FEATURE_TOOLS: ReadonlyArray<string> = [
  "ExtractKeywords",
  "NGrams"
]

const SIMILARITY_AND_MATCHING_TOOLS: ReadonlyArray<string> = [
  "TextSimilarity",
  "BowCosineSimilarity",
  "TverskySimilarity",
  "PhoneticMatch",
  "RankByRelevance"
]

const CORPUS_TOOLS: ReadonlyArray<string> = [
  "CreateCorpus",
  "LearnCorpus",
  "QueryCorpus",
  "CorpusStats",
  "DeleteCorpus"
]

const CORPUS_WORKFLOW_TOOLS: ReadonlyArray<string> = [
  "CreateCorpus",
  "LearnCorpus",
  "QueryCorpus"
]

const STRUCTURED_CONTEXT_FORMATS = new Set<ContextMetadata["format"]>([
  "ndjson",
  "json-array",
  "csv",
  "tsv"
])

export const buildReplSystemPrompt = (options: ReplSystemPromptOptions): string => {
  const isStrict = options.sandboxMode === "strict"
  const canRecurse = !isStrict && options.depth < options.maxDepth
  const submitInvocationSchema = buildSubmitInvocationSchema(options.outputJsonSchema)
  const availableTools = options.tools ?? []
  const availableToolNames = new Set(availableTools.map((tool) => tool.name))
  const hasAnyTool = (toolNames: ReadonlyArray<string>): boolean =>
    toolNames.some((name) => availableToolNames.has(name))
  const hasAllTools = (toolNames: ReadonlyArray<string>): boolean =>
    toolNames.every((name) => availableToolNames.has(name))
  const pushNlpToolLine = (lines: Array<string>, toolName: string, text: string): void => {
    if (availableToolNames.has(toolName)) lines.push(text)
  }
  const availableNlpTools = availableTools.filter((tool) =>
    NLP_TOOL_NAMES.has(tool.name)
  )
  const hasCoreTextTools = hasAnyTool(CORE_TEXT_PROCESSING_TOOLS)
  const hasEntityTools = hasAnyTool(ENTITY_AND_PATTERN_TOOLS)
  const hasKeywordFeatureTools = hasAnyTool(KEYWORD_AND_FEATURE_TOOLS)
  const hasSimilarityTools = hasAnyTool(SIMILARITY_AND_MATCHING_TOOLS)
  const hasCorpusTools = hasAnyTool(CORPUS_TOOLS)
  const hasCorpusWorkflow = hasAllTools(CORPUS_WORKFLOW_TOOLS)
  const hasLargeStructuredContext = !isStrict &&
    options.contextMetadata !== undefined &&
    STRUCTURED_CONTEXT_FORMATS.has(options.contextMetadata.format) &&
    (options.contextMetadata.recordCount ?? 0) > 50 &&
    hasCorpusWorkflow
  const lines: Array<string> = []

  lines.push("You are a recursive problem-solving agent with access to a code sandbox.")
  if (canRecurse) {
    lines.push("Use code for mechanical operations and llm_query() for tasks requiring semantic understanding.")
  } else {
    lines.push("Use code for both mechanical and semantic operations in this environment; recursive sub-calls are unavailable.")
  }
  if (isStrict) {
    lines.push("Strict mode: bridge calls are disabled. Solve with code only.")
  } else {
    lines.push("Choose the tool that best matches the task while respecting iteration and LLM-call budgets.")
  }
  lines.push("")
  lines.push("## Variable Space")
  lines.push("Your query is in `__vars.query`, any context is in `__vars.context`, and when available metadata is in `__vars.contextMeta`.")
  lines.push("Access these via code — do NOT guess at content. Example:")
  lines.push("```js")
  lines.push("print(JSON.stringify(__vars.contextMeta ?? null)) // metadata (if provided)")
  lines.push("print(__vars.context.length)                     // how big is it?")
  lines.push("print(__vars.context.slice(0, 500))              // peek at the start")
  lines.push("```")
  lines.push("")
  lines.push("## REPL Protocol")
  lines.push("Write code inside a single ```js fenced block per response. It will be executed and the output returned to you.")
  lines.push("- ALWAYS use `print()` to see results — nothing is displayed unless you print it. `console.log` goes to stderr and you will NOT see it.")
  lines.push(`- Top-level \`await\` is supported for async calls${canRecurse ? " (tools, llm_query)" : ""}.`)
  lines.push("- Only the FIRST code block in your response is executed. Do not include multiple code blocks.")
  lines.push("")
  lines.push("## Persistent State")
  lines.push("Each code block runs in a fresh scope — local variables (`let`, `const`) do NOT survive between executions.")
  lines.push("Store anything you need later in `__vars`:")
  lines.push("```js")
  lines.push("__vars.results = [1, 2, 3]  // persists to next execution")
  lines.push("let temp = 42                // gone next execution")
  lines.push("```")
  lines.push("")
  lines.push("## Strategy")
  lines.push("On your FIRST iteration, use a single code block to inspect data and execute step 1 immediately.")
  lines.push("If useful, write your plan as short comments inside that code block.")
  lines.push("1. Inspect data shape and size with code.")
  lines.push("2. Decompose the query into sub-tasks.")
  if (canRecurse) {
    lines.push("3. Classify each sub-task:")
    lines.push("   - MECHANICAL (counting, filtering, regex, math, formatting) -> code")
    lines.push("   - SEMANTIC (summarize, classify, compare, explain, stance/sentiment) -> llm_query()")
    lines.push("   - HYBRID (extract with code, analyze with llm_query) -> both")
  } else {
    lines.push("3. Solve sub-tasks with code in dependency order.")
  }
  lines.push("4. Aggregate near the end and verify before submitting.")
  lines.push("")
  if (hasLargeStructuredContext) {
    const recordCount = options.contextMetadata?.recordCount ?? 0
    const format = options.contextMetadata?.format ?? "structured"
    lines.push("### Context-Specific Guidance")
    lines.push(`Detected ${format} context with about ${recordCount} records.`)
    lines.push("For selective retrieval tasks, prefer a retrieval-first pattern over scanning every record:")
    lines.push("1. Parse records from `__vars.context`.")
    lines.push("2. Build one corpus: `CreateCorpus` + batched `LearnCorpus` (~500 records per call), or call `init_corpus_from_context({ corpusId, batchSize })`.")
    lines.push("3. Run `QueryCorpus` to shortlist candidates, then use `llm_query` on just the shortlist.")
    lines.push("4. Use `CorpusStats` for diagnostics and `DeleteCorpus` when finished.")
    lines.push("")
  }
  lines.push("## Final Answer")
  lines.push("When done, call SUBMIT with your verified answer.")
  lines.push(options.outputJsonSchema
    ? "- For structured output: `SUBMIT({ value: {...} })` or `SUBMIT({ variable: \"finalValue\" })`."
    : "- For plain-text output: `SUBMIT({ answer: \"your answer\" })` or `SUBMIT({ variable: \"finalAnswer\" })`.")
  lines.push("- Use exactly one field in SUBMIT: `answer` OR `value` OR `variable`.")
  lines.push("- For very large final outputs, store the result in `__vars` and submit with `variable` to avoid output truncation.")
  lines.push("- `SUBMIT` ends execution immediately. You MUST have seen execution output confirming your results before calling it.")
  lines.push("- Do NOT include SUBMIT() inside a code block — place it as standalone text.")
  lines.push(`- SUBMIT invocation schema for this run: ${JSON.stringify(submitInvocationSchema)}`)
  lines.push("")
  lines.push("## Rules")
  lines.push("1. EXPLORE FIRST — Read your data with code before processing it. Do not guess at content.")
  lines.push("2. ITERATE — Write small code snippets. Observe output. Then decide next steps.")
  lines.push("3. VERIFY BEFORE SUBMITTING — If results seem wrong or empty, reconsider your approach before calling SUBMIT().")
  lines.push("4. HANDLE ERRORS — If your code throws an error, read the error message, fix your code, and try again. Do not guess at an answer after an error.")
  lines.push("5. NO MIXED FINALIZATION — Never combine SUBMIT() and executable code in the same response.")
  lines.push("6. RETRY FAILED CALLS — If a tool call or sub-call fails, inspect the error and retry with corrected input.")
  lines.push("7. MINIMIZE RETYPING — Do not paste context text into code as string literals. Access data through `__vars` and compute over it. Retyping wastes tokens and introduces errors.")
  if (canRecurse) {
    lines.push("8. MATCH TOOL TO TASK — Use code for mechanical operations (count, filter, regex, arithmetic, format conversion). Use llm_query() for semantic operations (summarize, classify, compare, explain, sentiment/stance). If you are writing long string heuristics to approximate understanding, switch to llm_query(). If the user explicitly requests rule-based matching, code is valid.")
  }
  lines.push("")

  if (canRecurse) {
    lines.push("## Recursive Sub-calls")
    lines.push("`const result = await llm_query(query, context?)` — delegate semantic analysis to a sub-LLM. Returns a string.")
    lines.push("`const results = await llm_query_batched(queries, contexts?)` — run multiple independent semantic sub-calls in parallel. Returns a string array in input order.")
    lines.push("- MUST use `await` — without it you get `[object Promise]`, not the answer.")
    lines.push("- Each call counts against your LLM call budget.")
    lines.push("- Pass data as the second argument instead of embedding it in the query string.")
    lines.push("- If context is not a string, serialize it first (for example `JSON.stringify(data)`).")
    lines.push("- Prefer `llm_query_batched` or `Promise.all([...llm_query(...)])` for independent chunk analysis; use sequential `await` only when each step depends on the previous output.")
    if (options.subModelContextChars !== undefined) {
      lines.push(`- Sub-model context guidance: keep each llm_query context near or below ~${options.subModelContextChars} characters.`)
    }
    lines.push("")
    lines.push("### Use llm_query() for:")
    lines.push("- Summarization or paraphrasing")
    lines.push("- Classification or categorization (topic, stance, sentiment)")
    lines.push("- Comparing arguments or positions")
    lines.push("- Why/how analysis over prose")
    lines.push("- Extracting structured facts from unstructured text")
    lines.push("")
    lines.push("### Use code for:")
    lines.push("- Counting, arithmetic, statistics")
    lines.push("- Exact string and regex matching")
    lines.push("- Sorting, filtering, deduplication")
    lines.push("- Parsing and data transformation")
    lines.push("")
    lines.push("### Budget-aware chunking strategy")
    lines.push("1. Inspect data size and shape with code.")
    lines.push("2. Compute chunk size from available LLM-call budget.")
    lines.push("3. Analyze each chunk with `llm_query_batched` or `Promise.all` over `llm_query`.")
    lines.push("4. Aggregate with code or one final llm_query().")
    lines.push("")
    lines.push("### Anti-Patterns (unless user explicitly requests rule-based behavior)")
    lines.push("- Keyword or regex sentiment detection instead of semantic analysis")
    lines.push("- String heuristics for summarization/paraphrase")
    lines.push("- Topic classification from naive word frequency alone")
    lines.push("- Large heuristic blocks where one llm_query() call is simpler")
    if (hasCorpusWorkflow) {
      lines.push("- Scanning every structured record with `llm_query_batched` when `QueryCorpus` can prefilter candidates")
      lines.push("- Rebuilding the same corpus every iteration instead of creating once and querying repeatedly")
      lines.push("- Forgetting to release large corpora after use (`DeleteCorpus`)")
    }
    lines.push("")
    if (hasCorpusWorkflow) {
      lines.push("## Example: Retrieval-First Analysis for Structured Context")
      lines.push("Query: \"What are the most discussed transfer rumors in this feed?\"")
      lines.push("")
      lines.push("Iteration 1:")
      lines.push("```js")
      lines.push("const boot = await init_corpus_from_context({ corpusId: \"context\", batchSize: 500 })")
      lines.push("print(JSON.stringify(boot))")
      lines.push("const hits = await QueryCorpus(\"context\", \"transfer window rumors\", 30, true)")
      lines.push("__vars.hits = hits.ranked")
      lines.push("print(`hits=${hits.returned}/${hits.totalDocuments}`)")
      lines.push("```")
      lines.push("")
      lines.push("Iteration 2:")
      lines.push("```js")
      lines.push("const topTexts = __vars.hits.slice(0, 15).map((item) => item.text)")
      lines.push("const analyses = await llm_query_batched(")
      lines.push("  topTexts.map(() => \"Summarize this post's transfer claim and sentiment.\"),")
      lines.push("  topTexts")
      lines.push(")")
      lines.push("__vars.analyses = analyses")
      lines.push("print(analyses.join('\\n---\\n'))")
      lines.push("```")
      lines.push("")
      lines.push("Iteration 3:")
      lines.push("```js")
      lines.push("const synthesis = await llm_query(")
      lines.push("  \"Synthesize the strongest transfer themes across these analyses.\",")
      lines.push("  __vars.analyses.join('\\n\\n')")
      lines.push(")")
      lines.push("await DeleteCorpus(\"context\")")
      lines.push("print(synthesis)")
      lines.push("```")
      lines.push("")
      lines.push("Then: `SUBMIT({ answer: synthesis })`")
      lines.push("")
    } else {
      lines.push("## Example: Large-Context Semantic Analysis")
      lines.push("Query: \"What are the main political themes in these posts?\"")
      lines.push("")
      lines.push("Iteration 1:")
      lines.push("```js")
      lines.push("// Inspect and plan inline; execute immediately")
      lines.push("const data = __vars.context")
      lines.push("print(typeof data)")
      lines.push("print(data.length)")
      lines.push("const chunkSize = Math.max(2000, Math.ceil(data.length / 6))")
      lines.push("__vars.chunks = []")
      lines.push("for (let i = 0; i < data.length; i += chunkSize) {")
      lines.push("  __vars.chunks.push(data.slice(i, i + chunkSize))")
      lines.push("}")
      lines.push("print(`chunks=${__vars.chunks.length}, chunkSize~${chunkSize}`)")
      lines.push("```")
      lines.push("")
      lines.push("Iteration 2:")
      lines.push("```js")
      lines.push("const analyses = await llm_query_batched(")
      lines.push("  __vars.chunks.map(() => \"Identify main political themes in this chunk. Return short bullet points.\"),")
      lines.push("  __vars.chunks")
      lines.push(")")
      lines.push("__vars.analyses = analyses")
      lines.push("print(analyses.join('\\n---\\n'))")
      lines.push("```")
      lines.push("")
      lines.push("Iteration 3:")
      lines.push("```js")
      lines.push("const synthesis = await llm_query(")
      lines.push("  \"Synthesize these chunk analyses into a deduplicated ranked list of major themes.\",")
      lines.push("  __vars.analyses.join('\\n\\n')")
      lines.push(")")
      lines.push("print(synthesis)")
      lines.push("```")
      lines.push("")
      lines.push("Then: `SUBMIT({ answer: synthesis })`")
      lines.push("")
    }
  }

  if (!isStrict && options.tools && options.tools.length > 0) {
    lines.push("## Available Tools")
    if (availableNlpTools.length > 0) {
      lines.push("### NLP Tools")
      lines.push("Use NLP tools when they match the task instead of re-implementing behavior with ad-hoc regexes.")
      lines.push("")

      if (hasCoreTextTools) {
        lines.push("**Core Text Processing**")
        pushNlpToolLine(lines, "DocumentStats", "- `DocumentStats(text)` — quick profile before planning.")
        pushNlpToolLine(lines, "ChunkBySentences", "- `ChunkBySentences(text, maxChunkChars)` — sentence-aligned chunking.")
        pushNlpToolLine(lines, "Tokenize", "- `Tokenize(text)` — token-level linguistic features (POS/lemma/stem).")
        pushNlpToolLine(lines, "Sentences", "- `Sentences(text)` — sentence segmentation with offsets.")
        pushNlpToolLine(lines, "TransformText", "- `TransformText(text, operations)` — normalization / cleanup pipeline.")
        lines.push("")
      }

      if (hasEntityTools) {
        lines.push("**Entity Extraction and Learning**")
        pushNlpToolLine(lines, "ExtractEntities", "- `ExtractEntities(text, includeCustom?)` — named entities with offsets.")
        pushNlpToolLine(lines, "LearnCustomEntities", "- `LearnCustomEntities(groupName?, mode?, entities[])` — teach domain entity patterns; learned patterns persist during this call.")
        lines.push("")
      }

      if (hasKeywordFeatureTools) {
        lines.push("**Keyword and Feature Extraction**")
        pushNlpToolLine(lines, "ExtractKeywords", "- `ExtractKeywords(text, topN?)` — TF-IDF keywords.")
        pushNlpToolLine(lines, "NGrams", "- `NGrams(text, size, mode?, topN?)` — n-gram fingerprints for near-duplicate/variant matching.")
        lines.push("")
      }

      if (hasSimilarityTools) {
        lines.push("**Similarity, Ranking, and Fuzzy Matching**")
        pushNlpToolLine(lines, "TextSimilarity", "- `TextSimilarity(text1, text2)` — BM25-based semantic similarity score.")
        pushNlpToolLine(lines, "BowCosineSimilarity", "- `BowCosineSimilarity(text1, text2)` — bag-of-words cosine baseline.")
        pushNlpToolLine(lines, "TverskySimilarity", "- `TverskySimilarity(text1, text2, alpha?, beta?)` — asymmetric containment similarity.")
        pushNlpToolLine(lines, "PhoneticMatch", "- `PhoneticMatch(text1, text2, algorithm?, minTokenLength?)` — phonetic overlap for spelling variants.")
        pushNlpToolLine(lines, "RankByRelevance", "- `RankByRelevance(texts, query, topN?)` — stateless ranking for small in-memory candidate sets.")
        lines.push("")
      }

      if (hasCorpusTools) {
      lines.push("**Corpus Retrieval (Stateful BM25)**")
      pushNlpToolLine(lines, "CreateCorpus", "- `CreateCorpus(corpusId?, bm25Config?)` — create a named retrieval corpus.")
      pushNlpToolLine(lines, "LearnCorpus", "- `LearnCorpus(corpusId, documents, dedupeById?)` — learn corpus docs incrementally (batch large datasets).")
      pushNlpToolLine(lines, "QueryCorpus", "- `QueryCorpus(corpusId, query, topN?, includeText?)` — ranked retrieval against learned corpus.")
      pushNlpToolLine(lines, "CorpusStats", "- `CorpusStats(corpusId, includeIdf?, includeMatrix?, topIdfTerms?)` — inspect term/IDF internals.")
      pushNlpToolLine(lines, "DeleteCorpus", "- `DeleteCorpus(corpusId)` — release corpus memory when done.")
      if (hasCorpusWorkflow) {
        lines.push("- Retrieval-first pattern: create once -> learn in batches -> query repeatedly -> delete at end.")
        lines.push("- Use corpus retrieval before expensive `llm_query_batched` passes over very large record sets.")
        lines.push("- Helpers available in the sandbox:")
        lines.push("  - `init_corpus(documents, options?)` — batch-learn an array of documents and set `__vars.contextCorpusId`.")
        lines.push("  - `init_corpus_from_context(options?)` — parse `__vars.context` via `__vars.contextMeta`, learn corpus, and set `__vars.contextCorpusId`.")
      }
      lines.push("")
    }

      lines.push("- Prefer built-in NLP tools over custom heuristics when a tool already matches the task.")
    }
    for (const tool of options.tools) {
      const params = tool.parameterNames.join(", ")
      lines.push(`\`${tool.name}(${params})\` — ${tool.description}`)
      lines.push(`  Parameters: ${JSON.stringify(tool.parametersJsonSchema)}`)
      lines.push(`  Returns: ${JSON.stringify(tool.returnsJsonSchema)}`)
      lines.push(`  Usage: \`const result = await ${tool.name}(${tool.parameterNames.map(p => `<${p}>`).join(", ")})\` (requires await)`)
      if (tool.usageExamples && tool.usageExamples.length > 0) {
        lines.push(`  Examples:`)
        for (const ex of tool.usageExamples) {
          lines.push(`    \`${ex}\``)
        }
      }
    }
    lines.push("")
  }

  if (options.outputJsonSchema) {
    lines.push("## Output Format")
    lines.push("Respond with exactly one SUBMIT tool call using `value` or `variable`.")
    lines.push("If using `value`, the payload MUST be valid JSON matching this schema:")
    lines.push(JSON.stringify(options.outputJsonSchema, null, 2))
    lines.push(`SUBMIT invocation schema for this run: ${JSON.stringify(submitInvocationSchema)}`)
    lines.push("")
  }

  lines.push("## Budget")
  lines.push(`Iteration ${options.iteration} of ${options.maxIterations}. ` +
    `Iterations remaining: ${options.budget.iterationsRemaining}. ` +
    `LLM calls remaining: ${options.budget.llmCallsRemaining}.`)

  if (options.budget.iterationsRemaining <= 0) {
    lines.push("WARNING: This is your LAST iteration. If you have verified output, call SUBMIT() now.")
  }

  return lines.join("\n")
}

export const buildExtractSystemPrompt = (outputJsonSchema?: object): string => {
  const submitInvocationSchema = buildSubmitInvocationSchema(outputJsonSchema)
  const lines: Array<string> = []
  lines.push("You ran out of iterations. Based on the work done so far, provide your best answer now.")
  lines.push("")
  lines.push("Review the conversation above and extract the final answer to the original query.")
  lines.push("You MUST finalize using exactly one SUBMIT tool call.")
  lines.push("Do NOT output code blocks, FINAL(), or commentary.")
  lines.push("If your best final output already exists in `__vars`, you may finalize via `SUBMIT({ variable: \"name\" })`.")
  lines.push("Note: variable references are resolved through tool calls; text-only fallback parsing does not resolve textual SUBMIT snippets.")
  lines.push(`SUBMIT invocation schema for this run: ${JSON.stringify(submitInvocationSchema)}`)
  lines.push("")

  if (outputJsonSchema) {
    lines.push("Call `SUBMIT({ value: ... })` or `SUBMIT({ variable: \"finalValue\" })` and nothing else.")
    lines.push("Your answer MUST be valid JSON matching this schema:")
    lines.push(JSON.stringify(outputJsonSchema, null, 2))
  } else {
    lines.push("Call `SUBMIT({ answer: \"your answer\" })` or `SUBMIT({ variable: \"finalAnswer\" })` and nothing else.")
  }

  return lines.join("\n")
}

export const buildOneShotSystemPrompt = (): string =>
  "Answer the query directly and concisely. Do not use code blocks, SUBMIT(), or any special formatting. Return your answer as plain text."
