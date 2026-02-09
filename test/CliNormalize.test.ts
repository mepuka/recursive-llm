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
  subDelegationEnabled: false,
  disableSubDelegation: false,
  subDelegationDepthThreshold: Option.none(),
  maxIterations: Option.none(),
  maxDepth: Option.none(),
  maxLlmCalls: Option.none(),
  quiet: false,
  noColor: false,
  nlpTools: false
}

const fullEnv = {
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
  GOOGLE_API_KEY: "google-key"
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
        quiet: true,
        noColor: true
      },
      ["query", "--sub-delegation-enabled"]
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
      quiet: true,
      noColor: true,
      nlpTools: false
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
})
