import { Effect, Option, Schema } from "effect"
import type { CliArgs } from "../CliLayer"
import type { RlmProvider } from "../RlmConfig"

export interface ParsedCliConfig {
  readonly query: string
  readonly context: string
  readonly contextFile: Option.Option<string>
  readonly provider: RlmProvider
  readonly model: string
  readonly subModel: Option.Option<string>
  readonly subDelegationEnabled: boolean
  readonly disableSubDelegation: boolean
  readonly subDelegationDepthThreshold: Option.Option<number>
  readonly maxIterations: Option.Option<number>
  readonly maxDepth: Option.Option<number>
  readonly maxLlmCalls: Option.Option<number>
  readonly quiet: boolean
  readonly noColor: boolean
  readonly nlpTools: boolean
}

type CliEnv = Record<string, string | undefined>

export type ProviderApiKeyEnv = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY"

export class CliInputError extends Schema.TaggedError<CliInputError>()(
  "CliInputError",
  {
    message: Schema.String
  }
) {}

const toUndefined = <A>(option: Option.Option<A>): A | undefined =>
  Option.match(option, {
    onNone: () => undefined,
    onSome: (value) => value
  })

const failCliInput = (message: string) =>
  Effect.fail(new CliInputError({ message }))

export const providerApiKeyEnv = (provider: RlmProvider): ProviderApiKeyEnv =>
  provider === "anthropic"
    ? "ANTHROPIC_API_KEY"
    : provider === "openai"
    ? "OPENAI_API_KEY"
    : "GOOGLE_API_KEY"

export const resolveSubDelegationEnabled = (
  rawArgs: ReadonlyArray<string>,
  subDelegationEnabled: boolean,
  disableSubDelegation: boolean
): boolean | undefined => {
  if (!subDelegationEnabled && !disableSubDelegation) {
    return undefined
  }

  const enabledIndex = rawArgs.lastIndexOf("--sub-delegation-enabled")
  const disabledIndex = rawArgs.lastIndexOf("--disable-sub-delegation")

  if (enabledIndex === -1) return false
  if (disabledIndex === -1) return true
  return enabledIndex > disabledIndex
}

export const normalizeCliArgs = (
  parsed: ParsedCliConfig,
  rawArgs: ReadonlyArray<string>,
  env: CliEnv = Bun.env
): Effect.Effect<CliArgs, CliInputError> =>
  Effect.gen(function*() {
    const subModel = toUndefined(parsed.subModel)
    const contextFile = toUndefined(parsed.contextFile)
    const subDelegationDepthThreshold = toUndefined(parsed.subDelegationDepthThreshold)
    const maxIterations = toUndefined(parsed.maxIterations)
    const maxDepth = toUndefined(parsed.maxDepth)
    const maxLlmCalls = toUndefined(parsed.maxLlmCalls)
    const subDelegationEnabled = resolveSubDelegationEnabled(
      rawArgs,
      parsed.subDelegationEnabled,
      parsed.disableSubDelegation
    )

    if (
      subDelegationDepthThreshold !== undefined &&
      subDelegationDepthThreshold < 1
    ) {
      return yield* failCliInput("Error: --sub-delegation-depth-threshold must be an integer >= 1")
    }

    if (subDelegationEnabled === true && subModel === undefined) {
      return yield* failCliInput("Error: --sub-delegation-enabled requires --sub-model")
    }

    const apiKey = env[providerApiKeyEnv(parsed.provider)]
    if (!apiKey) {
      return yield* failCliInput(
        `Error: missing ${providerApiKeyEnv(parsed.provider)} for provider ${parsed.provider}`
      )
    }

    const cliArgs: CliArgs = {
      query: parsed.query,
      context: parsed.context,
      provider: parsed.provider,
      model: parsed.model,
      quiet: parsed.quiet,
      noColor: parsed.noColor,
      nlpTools: parsed.nlpTools,
      ...(contextFile !== undefined ? { contextFile } : {}),
      ...(subModel !== undefined ? { subModel } : {}),
      ...(subDelegationEnabled !== undefined ? { subDelegationEnabled } : {}),
      ...(subDelegationDepthThreshold !== undefined ? { subDelegationDepthThreshold } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxLlmCalls !== undefined ? { maxLlmCalls } : {})
    }

    return cliArgs
  })
