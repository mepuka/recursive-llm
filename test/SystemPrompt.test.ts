import { describe, expect, test } from "bun:test"
import { buildReplSystemPrompt, buildOneShotSystemPrompt, buildExtractSystemPrompt } from "../src/SystemPrompt"

describe("SystemPrompt", () => {
  const baseOptions = {
    depth: 0,
    iteration: 1,
    maxIterations: 10,
    maxDepth: 1,
    budget: { iterationsRemaining: 9, llmCallsRemaining: 19 }
  }
  const makeTool = (name: string) => ({
    name,
    description: `${name} description`,
    parameterNames: ["arg"],
    parametersJsonSchema: { type: "object" },
    returnsJsonSchema: { type: "object" }
  })

  test("REPL prompt does not contain FINAL(...) instructions", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).not.toContain("FINAL(")
  })

  test("REPL prompt contains SUBMIT instruction", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("SUBMIT")
  })

  test("REPL prompt includes SUBMIT invocation schema guidance", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("SUBMIT invocation schema for this run")
    expect(prompt).toContain("\"required\":[\"answer\"]")
    expect(prompt).toContain("\"required\":[\"variable\"]")
    expect(prompt).toContain("\"additionalProperties\":false")
  })

  test("REPL prompt documents SUBMIT variable finalization option", () => {
    const plainPrompt = buildReplSystemPrompt(baseOptions)
    expect(plainPrompt).toContain("SUBMIT({ variable: \"finalAnswer\" })")

    const structuredPrompt = buildReplSystemPrompt({
      ...baseOptions,
      outputJsonSchema: { type: "object", properties: { ok: { type: "boolean" } } }
    })
    expect(structuredPrompt).toContain("SUBMIT({ variable: \"finalValue\" })")
  })

  test("REPL prompt contains llm_query when depth < maxDepth", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 0, maxDepth: 1 })
    expect(prompt).toContain("llm_query")
  })

  test("REPL prompt contains llm_query_batched guidance when depth < maxDepth", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 0, maxDepth: 1 })
    expect(prompt).toContain("llm_query_batched")
    expect(prompt).toContain("Promise.all")
  })

  test("REPL prompt contains Strategy section", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("## Strategy")
    expect(prompt).toContain("On your FIRST iteration")
  })

  test("REPL prompt rewrites Rule 8 to MATCH TOOL TO TASK", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 0, maxDepth: 1 })
    expect(prompt).toContain("MATCH TOOL TO TASK")
    expect(prompt).not.toContain("PREFER CODE OVER SUB-CALLS")
  })

  test("REPL prompt omits llm_query when depth >= maxDepth", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 1, maxDepth: 1 })
    expect(prompt).not.toContain("llm_query")
  })

  test("REPL prompt includes recursive example when depth < maxDepth", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 0, maxDepth: 1 })
    expect(prompt).toContain("## Example: Large-Context Semantic Analysis")
    expect(prompt).toContain("### Anti-Patterns")
  })

  test("REPL prompt omits recursive example when depth >= maxDepth", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 1, maxDepth: 1 })
    expect(prompt).not.toContain("## Example: Large-Context Semantic Analysis")
    expect(prompt).not.toContain("### Anti-Patterns")
  })

  test("REPL prompt includes sub-model context hint when provided", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      depth: 0,
      maxDepth: 1,
      subModelContextChars: 12_345
    })
    expect(prompt).toContain("~12345 characters")
  })

  test("REPL prompt contains budget numbers", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("Iterations remaining: 9")
    expect(prompt).toContain("LLM calls remaining: 19")
  })

  test("REPL prompt instructs to access __vars.context, __vars.query, and __vars.contextMeta", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("__vars.context")
    expect(prompt).toContain("__vars.query")
    expect(prompt).toContain("__vars.contextMeta")
  })

  test("REPL prompt does NOT contain actual context content", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).not.toContain("some actual user context data")
  })

  test("one-shot prompt does NOT mention tool-call syntax or code blocks", () => {
    const prompt = buildOneShotSystemPrompt()
    expect(prompt).not.toContain("```")
    expect(prompt).toContain("Do not use code blocks")
    expect(prompt).toContain("SUBMIT()")
    expect(prompt).not.toContain("FINAL()")
  })

  test("REPL prompt includes tool documentation when tools provided", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      tools: [{
        name: "search",
        description: "Search the web",
        parameterNames: ["query", "maxResults"],
        parametersJsonSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } } },
        returnsJsonSchema: { type: "array" }
      }]
    })
    expect(prompt).toContain("## Available Tools")
    expect(prompt).toContain("search(query, maxResults)")
    expect(prompt).toContain("Search the web")
  })

  test("REPL prompt includes workflow-oriented NLP guidance when NLP tools are available", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      tools: [
        makeTool("DocumentStats"),
        makeTool("LearnCustomEntities"),
        makeTool("ExtractKeywords"),
        makeTool("TextSimilarity"),
        makeTool("CreateCorpus"),
        makeTool("LearnCorpus"),
        makeTool("QueryCorpus"),
        makeTool("DeleteCorpus")
      ]
    })
    expect(prompt).toContain("### NLP Tools")
    expect(prompt).toContain("Core Text Processing")
    expect(prompt).toContain("DocumentStats")
    expect(prompt).toContain("Entity Extraction and Learning")
    expect(prompt).toContain("LearnCustomEntities")
    expect(prompt).toContain("Keyword and Feature Extraction")
    expect(prompt).toContain("ExtractKeywords")
    expect(prompt).toContain("Similarity, Ranking, and Fuzzy Matching")
    expect(prompt).toContain("TextSimilarity")
    expect(prompt).toContain("Corpus Retrieval (Stateful BM25)")
    expect(prompt).toContain("CreateCorpus")
    expect(prompt).toContain("LearnCorpus")
    expect(prompt).toContain("QueryCorpus")
    expect(prompt).toContain("DeleteCorpus")
    expect(prompt).toContain("init_corpus(documents, options?)")
    expect(prompt).toContain("init_corpus_from_context(options?)")
  })

  test("REPL prompt includes context-specific retrieval guidance for large structured context with corpus tools", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      contextMetadata: {
        format: "ndjson",
        chars: 60_000,
        lines: 500,
        recordCount: 180
      },
      tools: [
        makeTool("CreateCorpus"),
        makeTool("LearnCorpus"),
        makeTool("QueryCorpus"),
        makeTool("CorpusStats"),
        makeTool("DeleteCorpus")
      ]
    })

    expect(prompt).toContain("### Context-Specific Guidance")
    expect(prompt).toContain("about 180 records")
    expect(prompt).toContain("prefer a retrieval-first pattern")
    expect(prompt).toContain("init_corpus_from_context")
    expect(prompt).toContain("CreateCorpus")
    expect(prompt).toContain("QueryCorpus")
  })

  test("REPL prompt omits context-specific retrieval guidance when corpus workflow tools are missing", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      contextMetadata: {
        format: "ndjson",
        chars: 60_000,
        lines: 500,
        recordCount: 180
      },
      tools: [
        makeTool("CreateCorpus"),
        makeTool("QueryCorpus")
      ]
    })

    expect(prompt).not.toContain("### Context-Specific Guidance")
  })

  test("REPL prompt omits tool section when no tools", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).not.toContain("## Available Tools")
  })

  test("REPL prompt includes output format when outputJsonSchema provided", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      outputJsonSchema: { type: "object", properties: { answer: { type: "number" } } }
    })
    expect(prompt).toContain("## Output Format")
    expect(prompt).toContain("valid JSON matching this schema")
    expect(prompt).toContain('"answer"')
  })

  test("REPL prompt omits output format when no outputJsonSchema", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).not.toContain("## Output Format")
  })

  test("strict mode suppresses llm_query even when depth < maxDepth", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 0, maxDepth: 1, sandboxMode: "strict" })
    expect(prompt).not.toContain("llm_query")
    expect(prompt).not.toContain("## Recursive Sub-calls")
    expect(prompt).toContain("Strict mode: bridge calls are disabled")
  })

  test("strict mode suppresses tools section", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      sandboxMode: "strict",
      tools: [{
        name: "search",
        description: "Search the web",
        parameterNames: ["query"],
        parametersJsonSchema: { type: "object" },
        returnsJsonSchema: { type: "array" }
      }]
    })
    expect(prompt).not.toContain("## Available Tools")
    expect(prompt).not.toContain("search")
  })

  test("REPL prompt contains EXPLORE FIRST rule", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("EXPLORE FIRST")
  })

  test("REPL prompt contains ITERATE rule", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("ITERATE")
  })

  test("REPL prompt contains VERIFY BEFORE SUBMITTING rule", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("VERIFY BEFORE SUBMITTING")
  })

  test("REPL prompt contains MINIMIZE RETYPING rule", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("MINIMIZE RETYPING")
  })

  test("REPL prompt contains scope semantics: local variables do NOT survive", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("local variables")
    expect(prompt).toContain("do NOT survive")
  })

  test("REPL prompt contains __vars.results example", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("__vars.results")
  })

  test("REPL prompt contains __vars.context.slice example", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("__vars.context.slice")
  })

  test("REPL prompt contains ALWAYS use print()", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("ALWAYS use `print()`")
  })

  test("REPL prompt contains MUST have seen execution output", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("MUST have seen execution output")
  })

  test("REPL prompt contains HANDLE ERRORS rule", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("HANDLE ERRORS")
  })

  test("REPL prompt contains do not paste context text", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("Do not paste context text")
  })

  test("REPL prompt contains [object Promise] warning when canRecurse", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 0, maxDepth: 1 })
    expect(prompt).toContain("[object Promise]")
  })

  test("last iteration (iterationsRemaining: 0) contains LAST iteration warning", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      budget: { iterationsRemaining: 0, llmCallsRemaining: 19 }
    })
    expect(prompt).toContain("LAST iteration")
  })

  test("penultimate iteration (iterationsRemaining: 1) does NOT contain LAST iteration warning", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      budget: { iterationsRemaining: 1, llmCallsRemaining: 19 }
    })
    expect(prompt).not.toContain("LAST iteration")
  })

  test("REPL prompt warns about console.log", () => {
    const prompt = buildReplSystemPrompt(baseOptions)
    expect(prompt).toContain("console.log")
    expect(prompt).toContain("stderr")
  })

  test("REPL prompt mentions await for llm_query", () => {
    const prompt = buildReplSystemPrompt({ ...baseOptions, depth: 0, maxDepth: 1 })
    expect(prompt).toContain("await llm_query")
  })

  test("tool usage includes await requirement", () => {
    const prompt = buildReplSystemPrompt({
      ...baseOptions,
      tools: [{
        name: "fetch",
        description: "Fetch a URL",
        parameterNames: ["url"],
        parametersJsonSchema: { type: "object" },
        returnsJsonSchema: { type: "string" }
      }]
    })
    expect(prompt).toContain("(requires await)")
  })
})

describe("buildExtractSystemPrompt", () => {
  test("returns SUBMIT-only extraction instruction", () => {
    const prompt = buildExtractSystemPrompt()
    expect(prompt).toContain("SUBMIT")
    expect(prompt).toContain("ran out of iterations")
    expect(prompt).toContain('SUBMIT({ answer: "your answer" })')
    expect(prompt).toContain('SUBMIT({ variable: "finalAnswer" })')
    expect(prompt).toContain("SUBMIT invocation schema for this run")
    expect(prompt).not.toContain('FINAL("your answer")')
  })

  test("includes JSON schema when provided", () => {
    const schema = { type: "object", properties: { result: { type: "number" } } }
    const prompt = buildExtractSystemPrompt(schema)
    expect(prompt).toContain("valid JSON matching this schema")
    expect(prompt).toContain('"result"')
    expect(prompt).toContain("SUBMIT({ value: ... })")
    expect(prompt).toContain('SUBMIT({ variable: "finalValue" })')
    expect(prompt).toContain("\"required\":[\"value\"]")
    expect(prompt).toContain("\"required\":[\"variable\"]")
    expect(prompt).not.toContain("Fallback only if tool calling is unavailable")
    expect(prompt).not.toContain("FINAL(`{...}`)")
  })

  test("omits schema section when not provided", () => {
    const prompt = buildExtractSystemPrompt()
    expect(prompt).not.toContain("valid JSON matching this schema")
  })
})
