import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import {
  type ParsedCliConfig,
  providerApiKeyEnv,
  resolveSubDelegationEnabled,
  normalizeCliArgs
} from "../src/cli/Normalize"

const baseParsed: ParsedCliConfig = {
  query: "What is recursive decomposition?",
  context: "context",
  contextFile: Option.none(),
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
  subModel: Option.none(),
  namedModel: [],
  media: [],
  mediaUrl: [],
  subDelegationEnabled: false,
  disableSubDelegation: false,
  subDelegationDepthThreshold: Option.none(),
  maxIterations: Option.none(),
  maxDepth: Option.none(),
  maxLlmCalls: Option.none(),
  maxTotalTokens: Option.none(),
  maxTimeMs: Option.none(),
  sandboxTransport: Option.none(),
  noPromptCaching: false,
  noCache: false,
  quiet: false,
  noColor: false,
  verbose: false,
  nlpTools: false,
  outputFile: Option.none(),
  bridgeTimeout: Option.none(),
  noTrace: false,
  traceDir: Option.none()
}

const fullEnv = {
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
  GOOGLE_API_KEY: "google-key",
  GOOGLE_API_URL: "https://vertex.googleapis.com"
}

const normalize = (
  parsed: ParsedCliConfig,
  rawArgs: ReadonlyArray<string>,
  env: Record<string, string | undefined> = fullEnv
) =>
  Effect.runPromise(normalizeCliArgs(parsed, rawArgs, env))

describe("CLI normalization", () => {
  test("maps provider to api key env var", () => {
    expect(providerApiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY")
    expect(providerApiKeyEnv("openai")).toBe("OPENAI_API_KEY")
    expect(providerApiKeyEnv("google")).toBe("GOOGLE_API_KEY")
  })

  test("maps parsed options into CliArgs with optional fields", async () => {
    const cliArgs = await normalize(
      {
        ...baseParsed,
        contextFile: Option.some("/tmp/context.txt"),
        provider: "google",
        model: "gemini-2.0-pro",
        subModel: Option.some("gemini-2.0-flash"),
        subDelegationEnabled: true,
        subDelegationDepthThreshold: Option.some(2),
        maxIterations: Option.some(70),
        maxDepth: Option.some(4),
        maxLlmCalls: Option.some(140),
        noPromptCaching: true,
        quiet: true,
        noColor: true
      },
      ["query", "--sub-delegation-enabled", "--no-prompt-caching"]
    )

    expect(cliArgs).toEqual({
      query: "What is recursive decomposition?",
      context: "context",
      contextFile: "/tmp/context.txt",
      provider: "google",
      model: "gemini-2.0-pro",
      subModel: "gemini-2.0-flash",
      subDelegationEnabled: true,
      subDelegationDepthThreshold: 2,
      maxIterations: 70,
      maxDepth: 4,
      maxLlmCalls: 140,
      enablePromptCaching: false,
      quiet: true,
      noColor: true,
      verbose: false,
      nlpTools: false,
      googleApiKey: "google-key",
      googleApiUrl: "https://vertex.googleapis.com"
    })
  })

  test("resolves sub delegation flag with last-flag-wins behavior", () => {
    expect(resolveSubDelegationEnabled(["--sub-delegation-enabled"], true, false)).toBe(true)
    expect(resolveSubDelegationEnabled(["--disable-sub-delegation"], false, true)).toBe(false)
    expect(
      resolveSubDelegationEnabled(
        ["--sub-delegation-enabled", "--disable-sub-delegation"],
        true,
        true
      )
    ).toBe(false)
    expect(
      resolveSubDelegationEnabled(
        ["--disable-sub-delegation", "--sub-delegation-enabled"],
        true,
        true
      )
    ).toBe(true)
  })

  test("leaves delegation undefined when neither delegation flag is present", async () => {
    const cliArgs = await normalize(baseParsed, ["query"])
    expect(cliArgs.subDelegationEnabled).toBeUndefined()
  })

  test("leaves prompt caching default when no disable flag is present", async () => {
    const cliArgs = await normalize(baseParsed, ["query"])
    expect(cliArgs.enablePromptCaching).toBeUndefined()
  })

  test("maps --no-cache to noCache=true", async () => {
    const cliArgs = await normalize(
      {
        ...baseParsed,
        noCache: true
      },
      ["query", "--no-cache"]
    )
    expect(cliArgs.noCache).toBe(true)
  })

  test("fails when delegation is explicitly enabled without sub model", async () => {
    await expect(
      normalize(
        {
          ...baseParsed,
          subDelegationEnabled: true
        },
        ["query", "--sub-delegation-enabled"]
      )
    ).rejects.toThrow("Error: --sub-delegation-enabled requires --sub-model")
  })

  test("fails when sub delegation depth threshold is less than one", async () => {
    await expect(
      normalize(
        {
          ...baseParsed,
          subDelegationDepthThreshold: Option.some(0)
        },
        ["query", "--sub-delegation-depth-threshold", "0"]
      )
    ).rejects.toThrow("Error: --sub-delegation-depth-threshold must be an integer >= 1")
  })

  test("fails when max iterations is less than one", async () => {
    await expect(
      normalize(
        {
          ...baseParsed,
          maxIterations: Option.some(0)
        },
        ["query", "--max-iterations", "0"]
      )
    ).rejects.toThrow("Error: --max-iterations must be an integer >= 1")
  })

  test("fails when max depth is negative", async () => {
    await expect(
      normalize(
        {
          ...baseParsed,
          maxDepth: Option.some(-1)
        },
        ["query", "--max-depth", "-1"]
      )
    ).rejects.toThrow("Error: --max-depth must be an integer >= 0")
  })

  test("fails when max llm calls is less than one", async () => {
    await expect(
      normalize(
        {
          ...baseParsed,
          maxLlmCalls: Option.some(0)
        },
        ["query", "--max-llm-calls", "0"]
      )
    ).rejects.toThrow("Error: --max-llm-calls must be an integer >= 1")
  })

  test("fails when provider api key is missing", async () => {
    await expect(
      normalize(
        {
          ...baseParsed,
          provider: "openai"
        },
        ["query", "--provider", "openai"],
        {
          ANTHROPIC_API_KEY: "anthropic-key",
          GOOGLE_API_KEY: "google-key"
        }
      )
    ).rejects.toThrow("Error: missing OPENAI_API_KEY for provider openai")
  })

  test("parses named models, media flags, and budget transport options", async () => {
    const cliArgs = await normalize(
      {
        ...baseParsed,
        namedModel: [
          "fast=openai/gpt-4o-mini",
          "vision=google/gemini-2.5-flash"
        ],
        media: [
          "invoice=/tmp/invoice.pdf",
          "photo=/tmp/a.png"
        ],
        mediaUrl: [
          "diagram=https://example.com/diagram.png",
          "photo=https://example.com/override.jpg"
        ],
        maxTotalTokens: Option.some(10_000),
        maxTimeMs: Option.some(60_000),
        sandboxTransport: Option.some("worker" as const)
      },
      [
        "query",
        "--named-model",
        "fast=openai/gpt-4o-mini",
        "--named-model",
        "vision=google/gemini-2.5-flash",
        "--media",
        "invoice=/tmp/invoice.pdf",
        "--media-url",
        "diagram=https://example.com/diagram.png"
      ]
    )

    expect(cliArgs.namedModels).toEqual({
      fast: { provider: "openai", model: "gpt-4o-mini" },
      vision: { provider: "google", model: "gemini-2.5-flash" }
    })
    expect(cliArgs.maxTotalTokens).toBe(10_000)
    expect(cliArgs.maxTimeMs).toBe(60_000)
    expect(cliArgs.sandboxTransport).toBe("worker")
    expect(cliArgs.media).toEqual([
      { name: "invoice", path: "/tmp/invoice.pdf" },
      { name: "photo", path: "/tmp/a.png" }
    ])
    expect(cliArgs.mediaUrls).toEqual([
      { name: "diagram", url: "https://example.com/diagram.png" },
      { name: "photo", url: "https://example.com/override.jpg" }
    ])
  })

  test("includes resolved provider credentials for primary and named model providers", async () => {
    const cliArgs = await normalize(
      {
        ...baseParsed,
        provider: "anthropic",
        namedModel: [
          "fast=openai/gpt-4o-mini",
          "vision=google/gemini-2.5-flash"
        ]
      },
      [
        "query",
        "--named-model",
        "fast=openai/gpt-4o-mini",
        "--named-model",
        "vision=google/gemini-2.5-flash"
      ]
    )

    expect(cliArgs.anthropicApiKey).toBe("anthropic-key")
    expect(cliArgs.openaiApiKey).toBe("openai-key")
    expect(cliArgs.googleApiKey).toBe("google-key")
    expect(cliArgs.googleApiUrl).toBe("https://vertex.googleapis.com")
  })
})
