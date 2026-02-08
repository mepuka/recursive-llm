import { buildSubmitInvocationSchema } from "./SubmitTool"

export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameterNames: ReadonlyArray<string>
  readonly parametersJsonSchema: object
  readonly returnsJsonSchema: object
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
}

export const buildReplSystemPrompt = (options: ReplSystemPromptOptions): string => {
  const isStrict = options.sandboxMode === "strict"
  const canRecurse = !isStrict && options.depth < options.maxDepth
  const submitInvocationSchema = buildSubmitInvocationSchema(options.outputJsonSchema)
  const lines: Array<string> = []

  lines.push("You are a recursive problem-solving agent with access to a code sandbox.")
  if (canRecurse) {
    lines.push("Use code for mechanical operations and llm_query() for tasks requiring semantic understanding.")
  } else {
    lines.push("Use code for both mechanical and semantic operations in this environment; recursive sub-calls are unavailable.")
  }
  lines.push("Choose the tool that best matches the task while respecting iteration and LLM-call budgets.")
  lines.push("")
  lines.push("## Variable Space")
  lines.push("Your query is in `__vars.query` and any context is in `__vars.context`.")
  lines.push("Access these via code — do NOT guess at content. Example:")
  lines.push("```js")
  lines.push("print(__vars.context.length)         // how big is it?")
  lines.push("print(__vars.context.slice(0, 500))  // peek at the start")
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
  lines.push("## Final Answer")
  lines.push("When done, call SUBMIT with your verified answer.")
  lines.push(options.outputJsonSchema
    ? "- For structured output: `SUBMIT({ value: {...} })`."
    : "- For plain-text output: `SUBMIT({ answer: \"your answer\" })`.")
  lines.push("- Use exactly one field in SUBMIT: `answer` OR `value`.")
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
    lines.push("")
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

  if (!isStrict && options.tools && options.tools.length > 0) {
    lines.push("## Available Tools")
    for (const tool of options.tools) {
      const params = tool.parameterNames.join(", ")
      lines.push(`\`${tool.name}(${params})\` — ${tool.description}`)
      lines.push(`  Parameters: ${JSON.stringify(tool.parametersJsonSchema)}`)
      lines.push(`  Returns: ${JSON.stringify(tool.returnsJsonSchema)}`)
      lines.push(`  Usage: \`const result = await ${tool.name}(${tool.parameterNames.map(p => `<${p}>`).join(", ")})\` (requires await)`)
    }
    lines.push("")
  }

  if (options.outputJsonSchema) {
    lines.push("## Output Format")
    lines.push("Respond with exactly one SUBMIT tool call using `value`.")
    lines.push("The `value` payload MUST be valid JSON matching this schema:")
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
  lines.push(`SUBMIT invocation schema for this run: ${JSON.stringify(submitInvocationSchema)}`)
  lines.push("")

  if (outputJsonSchema) {
    lines.push("Call `SUBMIT({ value: ... })` and nothing else.")
    lines.push("Your answer MUST be valid JSON matching this schema:")
    lines.push(JSON.stringify(outputJsonSchema, null, 2))
  } else {
    lines.push("Call `SUBMIT({ answer: \"your answer\" })` and nothing else.")
  }

  return lines.join("\n")
}

export const buildOneShotSystemPrompt = (): string =>
  "Answer the query directly and concisely. Do not use code blocks, SUBMIT(), or any special formatting. Return your answer as plain text."
