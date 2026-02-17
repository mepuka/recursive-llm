import { Effect, Option, Schema } from "effect"
import type { CliArgs } from "../CliLayer"
import type { RlmModelTarget, RlmProvider } from "../RlmConfig"

export interface ParsedCliConfig {
  readonly query: string
  readonly context: string
  readonly contextFile: Option.Option<string>
  readonly provider: RlmProvider
  readonly model: string
  readonly subModel: Option.Option<string>
  readonly namedModel: ReadonlyArray<string>
  readonly media: ReadonlyArray<string>
  readonly mediaUrl: ReadonlyArray<string>
  readonly subDelegationEnabled: boolean
  readonly disableSubDelegation: boolean
  readonly subDelegationDepthThreshold: Option.Option<number>
  readonly maxIterations: Option.Option<number>
  readonly maxDepth: Option.Option<number>
  readonly maxLlmCalls: Option.Option<number>
  readonly maxTotalTokens: Option.Option<number>
  readonly maxTimeMs: Option.Option<number>
  readonly sandboxTransport: "auto" | "worker" | "spawn"
  readonly noPromptCaching: boolean
  readonly noCache: boolean
  readonly quiet: boolean
  readonly noColor: boolean
  readonly nlpTools: boolean
  readonly noTrace: boolean
  readonly traceDir: Option.Option<string>
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

const NAMED_MODEL_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

const isProvider = (value: string): value is RlmProvider =>
  value === "anthropic" || value === "openai" || value === "google"

const parseNamedModelSpecs = (
  specs: ReadonlyArray<string>
): Effect.Effect<Record<string, RlmModelTarget> | undefined, CliInputError> =>
  Effect.gen(function*() {
    if (specs.length === 0) return undefined

    const namedModels: Record<string, RlmModelTarget> = {}
    for (const spec of specs) {
      const equalsIndex = spec.indexOf("=")
      if (equalsIndex <= 0 || equalsIndex === spec.length - 1) {
        return yield* failCliInput(`Error: invalid --named-model value "${spec}" (expected name=provider/model)`)
      }

      const name = spec.slice(0, equalsIndex).trim()
      const targetSpec = spec.slice(equalsIndex + 1).trim()
      const slashIndex = targetSpec.indexOf("/")

      if (!NAMED_MODEL_KEY_RE.test(name)) {
        return yield* failCliInput(
          `Error: invalid named model key "${name}" (use letters, numbers, _ or -, starting with a letter)`
        )
      }
      if (slashIndex <= 0 || slashIndex === targetSpec.length - 1) {
        return yield* failCliInput(
          `Error: invalid --named-model target "${targetSpec}" (expected provider/model)`
        )
      }

      const provider = targetSpec.slice(0, slashIndex).trim()
      const model = targetSpec.slice(slashIndex + 1).trim()
      if (!isProvider(provider)) {
        return yield* failCliInput(`Error: invalid provider "${provider}" in --named-model "${spec}"`)
      }
      if (model.length === 0) {
        return yield* failCliInput(`Error: model is empty in --named-model "${spec}"`)
      }

      namedModels[name] = {
        provider,
        model
      }
    }

    return Object.keys(namedModels).length > 0 ? namedModels : undefined
  })

const parseNamedPathSpecs = (
  specs: ReadonlyArray<string>,
  optionName: "--media" | "--media-url"
): Effect.Effect<Array<{ name: string; value: string }> | undefined, CliInputError> =>
  Effect.gen(function*() {
    if (specs.length === 0) return undefined

    const byName = new Map<string, string>()
    for (const spec of specs) {
      const equalsIndex = spec.indexOf("=")
      if (equalsIndex <= 0 || equalsIndex === spec.length - 1) {
        return yield* failCliInput(`Error: invalid ${optionName} value "${spec}" (expected name=value)`)
      }
      const name = spec.slice(0, equalsIndex).trim()
      const value = spec.slice(equalsIndex + 1).trim()

      if (!NAMED_MODEL_KEY_RE.test(name)) {
        return yield* failCliInput(
          `Error: invalid media key "${name}" in ${optionName} (use letters, numbers, _ or -, starting with a letter)`
        )
      }
      if (value.length === 0) {
        return yield* failCliInput(`Error: empty value in ${optionName} "${spec}"`)
      }
      if (optionName === "--media-url") {
        if (!URL.canParse(value)) {
          return yield* failCliInput(`Error: invalid URL "${value}" in ${optionName}`)
        }
      }

      byName.set(name, value)
    }

    return [...byName.entries()].map(([name, value]) => ({ name, value }))
  })

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
    const maxTotalTokens = toUndefined(parsed.maxTotalTokens)
    const maxTimeMs = toUndefined(parsed.maxTimeMs)
    const enablePromptCaching = parsed.noPromptCaching ? false : undefined
    const traceDir = toUndefined(parsed.traceDir)
    const namedModels = yield* parseNamedModelSpecs(parsed.namedModel)
    const media = yield* parseNamedPathSpecs(parsed.media, "--media")
    const mediaUrls = yield* parseNamedPathSpecs(parsed.mediaUrl, "--media-url")
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

    if (maxIterations !== undefined && maxIterations < 1) {
      return yield* failCliInput("Error: --max-iterations must be an integer >= 1")
    }

    if (maxDepth !== undefined && maxDepth < 0) {
      return yield* failCliInput("Error: --max-depth must be an integer >= 0")
    }

    if (maxLlmCalls !== undefined && maxLlmCalls < 1) {
      return yield* failCliInput("Error: --max-llm-calls must be an integer >= 1")
    }
    if (maxTotalTokens !== undefined && maxTotalTokens < 1) {
      return yield* failCliInput("Error: --max-total-tokens must be an integer >= 1")
    }
    if (maxTimeMs !== undefined && maxTimeMs < 1) {
      return yield* failCliInput("Error: --max-time-ms must be an integer >= 1")
    }

    if (subDelegationEnabled === true && subModel === undefined) {
      return yield* failCliInput("Error: --sub-delegation-enabled requires --sub-model")
    }

    const requiredProviders = new Set<RlmProvider>([
      parsed.provider,
      ...(namedModels !== undefined
        ? Object.values(namedModels).map((target) => target.provider)
        : [])
    ])

    let anthropicApiKey: string | undefined
    let openaiApiKey: string | undefined
    let googleApiKey: string | undefined

    for (const provider of requiredProviders) {
      const apiKey = env[providerApiKeyEnv(provider)]
      if (!apiKey) {
        return yield* failCliInput(
          `Error: missing ${providerApiKeyEnv(provider)} for provider ${provider}`
        )
      }
      if (provider === "anthropic") {
        anthropicApiKey = apiKey
      } else if (provider === "openai") {
        openaiApiKey = apiKey
      } else {
        googleApiKey = apiKey
      }
    }

    if (traceDir !== undefined && traceDir.trim().length === 0) {
      return yield* failCliInput("Error: --trace-dir must be a non-empty string")
    }

    const cliArgs: CliArgs = {
      query: parsed.query,
      context: parsed.context,
      provider: parsed.provider,
      model: parsed.model,
      quiet: parsed.quiet,
      noColor: parsed.noColor,
      nlpTools: parsed.nlpTools,
      ...(parsed.noTrace ? { noTrace: true } : {}),
      ...(contextFile !== undefined ? { contextFile } : {}),
      ...(subModel !== undefined ? { subModel } : {}),
      ...(subDelegationEnabled !== undefined ? { subDelegationEnabled } : {}),
      ...(subDelegationDepthThreshold !== undefined ? { subDelegationDepthThreshold } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxLlmCalls !== undefined ? { maxLlmCalls } : {}),
      ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
      ...(maxTimeMs !== undefined ? { maxTimeMs } : {}),
      sandboxTransport: parsed.sandboxTransport,
      ...(namedModels !== undefined ? { namedModels } : {}),
      ...(media !== undefined
        ? {
            media: media.map(({ name, value }) => ({ name, path: value }))
          }
        : {}),
      ...(mediaUrls !== undefined
        ? {
            mediaUrls: mediaUrls.map(({ name, value }) => ({ name, url: value }))
          }
        : {}),
      ...(traceDir !== undefined ? { traceDir } : {}),
      ...(enablePromptCaching !== undefined ? { enablePromptCaching } : {}),
      ...(parsed.noCache ? { noCache: true } : {}),
      ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
      ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
      ...(googleApiKey !== undefined ? { googleApiKey } : {}),
      ...(googleApiKey !== undefined && env.GOOGLE_API_URL !== undefined
        ? { googleApiUrl: env.GOOGLE_API_URL }
        : {})
    }

    return cliArgs
  })
