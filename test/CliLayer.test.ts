import { describe, expect, test } from "bun:test"
import { makeCliConfig, type CliArgs } from "../src/CliLayer"

const baseArgs: CliArgs = {
  query: "query",
  context: "context",
  provider: "anthropic",
  model: "model-a",
  quiet: false,
  noColor: false
}

describe("CliLayer config mapping", () => {
  test("maps provider and model into primary target", () => {
    const config = makeCliConfig({
      ...baseArgs,
      provider: "openai",
      model: "gpt-5"
    })

    expect(config.primaryTarget).toEqual({
      provider: "openai",
      model: "gpt-5"
    })
  })

  test("sets sub target when sub model is provided", () => {
    const config = makeCliConfig({
      ...baseArgs,
      provider: "google",
      model: "gemini-pro",
      subModel: "gemini-flash"
    })

    expect(config.subTarget).toEqual({
      provider: "google",
      model: "gemini-flash"
    })
  })

  test("omits sub target when sub model is not provided", () => {
    const config = makeCliConfig({
      ...baseArgs
    })

    expect(config.subTarget).toBeUndefined()
  })

  test("defaults delegation enabled when sub model is provided", () => {
    const config = makeCliConfig({
      ...baseArgs,
      subModel: "claude-haiku"
    })

    expect(config.subLlmDelegation.enabled).toBe(true)
    expect(config.subLlmDelegation.depthThreshold).toBe(1)
  })

  test("respects explicit delegation override and threshold", () => {
    const config = makeCliConfig({
      ...baseArgs,
      subModel: "claude-haiku",
      subDelegationEnabled: false,
      subDelegationDepthThreshold: 3
    })

    expect(config.subLlmDelegation.enabled).toBe(false)
    expect(config.subLlmDelegation.depthThreshold).toBe(3)
  })
})
