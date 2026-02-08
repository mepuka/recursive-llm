import { describe, expect, test } from "bun:test"
import {
  buildReplPrompt,
  buildOneShotPrompt,
  buildExtractPrompt,
  truncateOutput,
  truncateExecutionOutput,
  MAX_OUTPUT_CHARS,
  MAX_ONESHOT_CONTEXT_CHARS
} from "../src/RlmPrompt"
import { TranscriptEntry } from "../src/RlmTypes"

describe("truncateOutput", () => {
  test("passes through output under limit", () => {
    expect(truncateOutput("hello", 100)).toBe("hello")
  })

  test("truncates output over limit with suffix", () => {
    const long = "x".repeat(MAX_OUTPUT_CHARS + 100)
    const result = truncateOutput(long, MAX_OUTPUT_CHARS)
    expect(result.length).toBeLessThan(long.length)
    expect(result).toContain(`[truncated at ${long.length} chars]`)
    expect(result.startsWith("x".repeat(MAX_OUTPUT_CHARS))).toBe(true)
  })

  test("exact limit passes through", () => {
    const exact = "a".repeat(MAX_OUTPUT_CHARS)
    expect(truncateOutput(exact)).toBe(exact)
  })

  test("truncateExecutionOutput includes llm_query hint when truncated", () => {
    const long = "z".repeat(100)
    const result = truncateExecutionOutput(long, 20)
    expect(result).toContain("[Output truncated at 100 chars.")
    expect(result).toContain("llm_query()")
    expect(result).toContain("__vars state")
  })
})

describe("buildReplPrompt", () => {
  test("empty transcript → system + user messages only", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "You are an agent.",
      query: "What is 2+2?",
      contextLength: 0,
      contextPreview: "",
      transcript: []
    })
    expect(prompt.content).toHaveLength(2)
    expect(prompt.content[0]!.role).toBe("system")
    expect(prompt.content[1]!.role).toBe("user")
  })

  test("user message references __vars.context with char count when context provided", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "summarize",
      contextLength: 5000,
      contextPreview: "The quick brown fox",
      transcript: []
    })
    const userMsg = prompt.content[1]!
    expect(userMsg.role).toBe("user")
    // User message content is an array of parts for user messages
    const textContent = userMsg.role === "user"
      ? (userMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("__vars.context")
    expect(textContent).toContain("5000 chars")
    expect(textContent).toContain("The quick brown fox")
    // Should NOT contain the full context
    expect(textContent).not.toContain("x".repeat(5000))
  })

  test("with transcript → alternating assistant/user messages", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "compute",
      contextLength: 0,
      contextPreview: "",
      transcript: [
        new TranscriptEntry({
          assistantResponse: "```js\nprint(42)\n```",
          executionOutput: "42"
        })
      ]
    })
    // system + user + assistant + user(output) = 4 messages
    expect(prompt.content).toHaveLength(4)
    expect(prompt.content[0]!.role).toBe("system")
    expect(prompt.content[1]!.role).toBe("user")
    expect(prompt.content[2]!.role).toBe("assistant")
    expect(prompt.content[3]!.role).toBe("user")
  })

  test("transcript entries pass through without re-truncation", () => {
    const alreadyTruncated = "x".repeat(4000) + "\n[truncated at 10000 chars]"
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "q",
      contextLength: 0,
      contextPreview: "",
      transcript: [
        new TranscriptEntry({
          assistantResponse: "code",
          executionOutput: alreadyTruncated
        })
      ]
    })
    const lastMsg = prompt.content[3]!
    expect(lastMsg.role).toBe("user")
    const textContent = lastMsg.role === "user"
      ? (lastMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("[truncated at 10000 chars]")
    // Should not be double-truncated
    expect(textContent.match(/\[truncated/g)?.length).toBe(1)
  })

  test("transcript entry without executionOutput → only assistant message", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "q",
      contextLength: 0,
      contextPreview: "",
      transcript: [
        new TranscriptEntry({ assistantResponse: "thinking..." })
      ]
    })
    // system + user + assistant = 3 messages (no user reply for output)
    expect(prompt.content).toHaveLength(3)
    expect(prompt.content[2]!.role).toBe("assistant")
  })
})

describe("buildOneShotPrompt", () => {
  test("includes query and context inline", () => {
    const prompt = buildOneShotPrompt({
      systemPrompt: "Answer directly.",
      query: "What is 2+2?",
      context: "Math facts: 2+2=4"
    })
    expect(prompt.content).toHaveLength(2)
    expect(prompt.content[0]!.role).toBe("system")
    expect(prompt.content[1]!.role).toBe("user")
    const textContent = prompt.content[1]!.role === "user"
      ? (prompt.content[1]!.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("What is 2+2?")
    expect(textContent).toContain("Math facts: 2+2=4")
  })

  test("truncates context exceeding MAX_ONESHOT_CONTEXT_CHARS", () => {
    const longContext = "y".repeat(MAX_ONESHOT_CONTEXT_CHARS + 5000)
    const prompt = buildOneShotPrompt({
      systemPrompt: "system",
      query: "summarize",
      context: longContext
    })
    const textContent = prompt.content[1]!.role === "user"
      ? (prompt.content[1]!.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("[truncated at")
    expect(textContent).not.toContain("__vars")
    expect(textContent).not.toContain("llm_query()")
    expect(textContent.length).toBeLessThan(longContext.length)
  })

  test("empty context → query only", () => {
    const prompt = buildOneShotPrompt({
      systemPrompt: "system",
      query: "hello",
      context: ""
    })
    const textContent = prompt.content[1]!.role === "user"
      ? (prompt.content[1]!.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toBe("hello")
  })
})

describe("buildReplPrompt iteration-0 safeguard", () => {
  test("empty transcript + context > 0 → user message starts with safeguard", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "summarize",
      contextLength: 5000,
      contextPreview: "The quick brown fox",
      transcript: []
    })
    const userMsg = prompt.content[1]!
    const textContent = userMsg.role === "user"
      ? (userMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("You have not seen the context yet")
  })

  test("empty transcript + context = 0 → no safeguard", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "just answer",
      contextLength: 0,
      contextPreview: "",
      transcript: []
    })
    const userMsg = prompt.content[1]!
    const textContent = userMsg.role === "user"
      ? (userMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).not.toContain("You have not seen the context yet")
  })

  test("non-empty transcript + context > 0 → no safeguard", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "summarize",
      contextLength: 5000,
      contextPreview: "The quick brown fox",
      transcript: [
        new TranscriptEntry({
          assistantResponse: "```js\nprint(__vars.context.length)\n```",
          executionOutput: "5000"
        })
      ]
    })
    // Check the initial user message (index 1), not the execution output message
    const userMsg = prompt.content[1]!
    const textContent = userMsg.role === "user"
      ? (userMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).not.toContain("You have not seen the context yet")
  })
})

describe("buildReplPrompt empty output hint", () => {
  test("empty executionOutput shows hint", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "q",
      contextLength: 0,
      contextPreview: "",
      transcript: [
        new TranscriptEntry({
          assistantResponse: "```js\nfoo()\n```",
          executionOutput: ""
        })
      ]
    })
    const lastMsg = prompt.content[3]!
    const textContent = lastMsg.role === "user"
      ? (lastMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("(no output — did you forget to print?)")
  })

  test("non-empty executionOutput passes through", () => {
    const prompt = buildReplPrompt({
      systemPrompt: "system",
      query: "q",
      contextLength: 0,
      contextPreview: "",
      transcript: [
        new TranscriptEntry({
          assistantResponse: "code",
          executionOutput: "42"
        })
      ]
    })
    const lastMsg = prompt.content[3]!
    const textContent = lastMsg.role === "user"
      ? (lastMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("42")
    expect(textContent).not.toContain("did you forget to print")
  })
})

describe("buildExtractPrompt", () => {
  test("produces correct message sequence with transcript", () => {
    const prompt = buildExtractPrompt({
      systemPrompt: "Extract the answer.",
      query: "What is 2+2?",
      contextLength: 100,
      contextPreview: "math context",
      transcript: [
        new TranscriptEntry({
          assistantResponse: "```js\nprint(2+2)\n```",
          executionOutput: "4"
        })
      ]
    })
    // system + user + assistant + user(output) = 4 messages
    expect(prompt.content).toHaveLength(4)
    expect(prompt.content[0]!.role).toBe("system")
    expect(prompt.content[1]!.role).toBe("user")
    expect(prompt.content[2]!.role).toBe("assistant")
    expect(prompt.content[3]!.role).toBe("user")
  })

  test("user message says 'Context was available' (past tense)", () => {
    const prompt = buildExtractPrompt({
      systemPrompt: "system",
      query: "summarize",
      contextLength: 500,
      contextPreview: "preview text",
      transcript: []
    })
    const userMsg = prompt.content[1]!
    const textContent = userMsg.role === "user"
      ? (userMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("Context was available")
    expect(textContent).toContain("500 chars")
  })

  test("empty output shows '(no output)' hint", () => {
    const prompt = buildExtractPrompt({
      systemPrompt: "system",
      query: "q",
      contextLength: 0,
      contextPreview: "",
      transcript: [
        new TranscriptEntry({
          assistantResponse: "code",
          executionOutput: ""
        })
      ]
    })
    const lastMsg = prompt.content[3]!
    const textContent = lastMsg.role === "user"
      ? (lastMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toContain("(no output)")
  })

  test("no context → query only in user message", () => {
    const prompt = buildExtractPrompt({
      systemPrompt: "system",
      query: "hello",
      contextLength: 0,
      contextPreview: "",
      transcript: []
    })
    const userMsg = prompt.content[1]!
    const textContent = userMsg.role === "user"
      ? (userMsg.content as ReadonlyArray<{ readonly text: string }>)[0]!.text
      : ""
    expect(textContent).toBe("hello")
  })
})
