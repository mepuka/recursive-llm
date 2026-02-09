import { afterEach, describe, expect, test } from "bun:test"
import * as ValidationError from "@effect/cli/ValidationError"
import { BunContext } from "@effect/platform-bun"
import { Cause, Effect, Exit, Option } from "effect"
import type { CliArgs } from "../src/CliLayer"
import { runCliCommand } from "../src/cli/Command"
import { CliInputError } from "../src/cli/Normalize"

const env = {
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
  GOOGLE_API_KEY: "google-key"
}

const runWithCapture = async (argv: ReadonlyArray<string>) => {
  let captured: CliArgs | undefined

  await Effect.runPromise(
    runCliCommand(argv, {
      env,
      execute: (cliArgs) =>
        Effect.sync(() => {
          captured = cliArgs
        })
    }).pipe(Effect.provide(BunContext.layer))
  )

  return captured
}

const getFailure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected command to fail")
  }

  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    throw new Error("Expected failure cause")
  }

  return failure.value
}

afterEach(() => {
  process.exitCode = 0
})

describe("Effect CLI command", () => {
  test("parses query and options into CliArgs", async () => {
    const captured = await runWithCapture([
      "bun",
      "src/cli.ts",
      "cluster these articles",
      "--provider",
      "google",
      "--model",
      "gemini-2.0-pro",
      "--max-iterations",
      "80",
      "--max-depth",
      "3",
      "--max-llm-calls",
      "120",
      "--quiet",
      "--no-color"
    ])

    expect(captured).toEqual({
      query: "cluster these articles",
      context: "",
      provider: "google",
      model: "gemini-2.0-pro",
      maxIterations: 80,
      maxDepth: 3,
      maxLlmCalls: 120,
      quiet: true,
      noColor: true,
      nlpTools: false
    })
  })

  test("supports query-first invocation with options after query", async () => {
    const captured = await runWithCapture([
      "bun",
      "src/cli.ts",
      "summarize this",
      "--context",
      "extra context",
      "--provider",
      "openai"
    ])

    expect(captured).toEqual({
      query: "summarize this",
      context: "extra context",
      provider: "openai",
      model: "claude-sonnet-4-5-20250929",
      quiet: false,
      noColor: false,
      nlpTools: false
    })
  })

  test("uses last delegation flag when both are present", async () => {
    const captured = await runWithCapture([
      "bun",
      "src/cli.ts",
      "delegate this",
      "--sub-model",
      "claude-3-5-haiku",
      "--disable-sub-delegation",
      "--sub-delegation-enabled"
    ])

    expect(captured?.subDelegationEnabled).toBe(true)
  })

  test("fails with ValidationError for unknown options", async () => {
    const exit = await Effect.runPromiseExit(
      runCliCommand(
        ["bun", "src/cli.ts", "query", "--unknown-option"],
        { env, execute: () => Effect.void }
      ).pipe(Effect.provide(BunContext.layer))
    )

    const failure = getFailure(exit)
    expect(ValidationError.isValidationError(failure)).toBeTrue()
  })

  test("fails with CliInputError when sub delegation is enabled without sub model", async () => {
    const exit = await Effect.runPromiseExit(
      runCliCommand(
        ["bun", "src/cli.ts", "query", "--sub-delegation-enabled"],
        { env, execute: () => Effect.void }
      ).pipe(Effect.provide(BunContext.layer))
    )

    const failure = getFailure(exit)
    expect(failure).toBeInstanceOf(CliInputError)
    expect((failure as CliInputError).message).toBe("Error: --sub-delegation-enabled requires --sub-model")
  })
})
