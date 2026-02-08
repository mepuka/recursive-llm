import { AnthropicClient } from "@effect/ai-anthropic"
import { GoogleClient } from "@effect/ai-google"
import { OpenAiClient } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Match, Redacted, Stream } from "effect"
import { Rlm, rlmBunLayer } from "./Rlm"
import { RlmConfig, type RlmProvider } from "./RlmConfig"
import type { RlmModel } from "./RlmModel"
import { makeAnthropicRlmModel, makeGoogleRlmModel, makeOpenAiRlmModel } from "./RlmModel"
import { formatEvent, type RenderOptions } from "./RlmRenderer"

// --- Arg parsing ---

interface CliArgs {
  query: string
  context: string
  contextFile?: string
  provider: RlmProvider
  model: string
  subModel?: string
  subDelegationEnabled?: boolean
  subDelegationDepthThreshold?: number
  maxIterations?: number
  maxDepth?: number
  maxLlmCalls?: number
  quiet: boolean
  noColor: boolean
}

const PROVIDERS = ["anthropic", "openai", "google"] as const

const isRlmProvider = (value: string): value is RlmProvider =>
  PROVIDERS.includes(value as any)

const providerApiKeyEnv = (provider: RlmProvider): "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GOOGLE_API_KEY" =>
  provider === "anthropic"
    ? "ANTHROPIC_API_KEY"
    : provider === "openai"
    ? "OPENAI_API_KEY"
    : "GOOGLE_API_KEY"

const printUsage = () => {
  console.error(`Usage: bun run src/cli.ts <query> [options]

Options:
  --context <text>                          Context string
  --context-file <path>                     Read context from file
  --provider <name>                         Provider: anthropic (default), openai, google
  --model <name>                            Model name (default: claude-sonnet-4-5-20250929)
  --sub-model <name>                        Lower-tier model for delegated sub-LLM calls
  --sub-delegation-enabled                  Enable sub-LLM delegation (default: enabled when --sub-model is set)
  --disable-sub-delegation                  Disable sub-LLM delegation
  --sub-delegation-depth-threshold <n>      Minimum depth required to delegate to sub-model (default: 1)
  --max-iterations <n>                      Max iterations (default: 50)
  --max-depth <n>                           Max recursion depth (default: 1)
  --max-llm-calls <n>                       Max total LLM calls (default: 200)
  --quiet                                   Only show final answer and errors
  --no-color                                Disable ANSI colors

Environment:
  ANTHROPIC_API_KEY                         Required for anthropic provider
  OPENAI_API_KEY                            Required for openai provider
  GOOGLE_API_KEY                            Required for google provider`)
}

const parseArgs = (): CliArgs | null => {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage()
    return null
  }

  const result: CliArgs = {
    query: "",
    context: "",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    quiet: false,
    noColor: false
  }

  let i = 0
  // First non-flag argument is the query
  if (!args[0]!.startsWith("--")) {
    result.query = args[0]!
    i = 1
  }

  for (; i < args.length; i++) {
    const arg = args[i]!
    switch (arg) {
      case "--context":
        result.context = args[++i] ?? ""
        break
      case "--context-file": {
        const val = args[++i]
        if (val !== undefined) result.contextFile = val
        break
      }
      case "--provider": {
        const value = args[++i] ?? "anthropic"
        if (!isRlmProvider(value)) {
          console.error(`Invalid provider: ${value}. Use one of: ${PROVIDERS.join(", ")}`)
          return null
        }
        result.provider = value
        break
      }
      case "--model":
        result.model = args[++i] ?? result.model
        break
      case "--sub-model": {
        const val = args[++i]
        if (val !== undefined) result.subModel = val
        break
      }
      case "--sub-delegation-enabled":
        result.subDelegationEnabled = true
        break
      case "--disable-sub-delegation":
        result.subDelegationEnabled = false
        break
      case "--sub-delegation-depth-threshold":
        result.subDelegationDepthThreshold = parseInt(args[++i] ?? "1", 10)
        break
      case "--max-iterations":
        result.maxIterations = parseInt(args[++i] ?? "50", 10)
        break
      case "--max-depth":
        result.maxDepth = parseInt(args[++i] ?? "1", 10)
        break
      case "--max-llm-calls":
        result.maxLlmCalls = parseInt(args[++i] ?? "50", 10)
        break
      case "--quiet":
        result.quiet = true
        break
      case "--no-color":
        result.noColor = true
        break
      default:
        if (!result.query) {
          result.query = arg
        } else {
          console.error(`Unknown option: ${arg}`)
          printUsage()
          return null
        }
    }
  }

  if (!result.query) {
    console.error("Error: query is required")
    printUsage()
    return null
  }

  if (
    result.subDelegationDepthThreshold !== undefined &&
    (!Number.isInteger(result.subDelegationDepthThreshold) || result.subDelegationDepthThreshold < 1)
  ) {
    console.error("Error: --sub-delegation-depth-threshold must be an integer >= 1")
    return null
  }

  if (result.subDelegationEnabled === true && result.subModel === undefined) {
    console.error("Error: --sub-delegation-enabled requires --sub-model")
    return null
  }

  const apiKeyEnv = providerApiKeyEnv(result.provider)
  if (!Bun.env[apiKeyEnv]) {
    console.error(`Error: missing ${apiKeyEnv} for provider ${result.provider}`)
    return null
  }

  return result
}

// --- Main ---

const main = (cliArgs: CliArgs) =>
  Effect.gen(function*() {
    const context = cliArgs.contextFile
      ? yield* Effect.promise(() => Bun.file(cliArgs.contextFile!).text())
      : cliArgs.context

    const rlm = yield* Rlm

    const renderOpts: RenderOptions = {
      quiet: cliArgs.quiet,
      noColor: cliArgs.noColor
    }

    const result = yield* rlm.stream({ query: cliArgs.query, context }).pipe(
      Stream.runFoldEffect(
        { answer: "", failed: false },
        (state, event) =>
          Effect.sync(() => {
            const formatted = formatEvent(event, renderOpts)
            if (formatted) process.stderr.write(formatted)
            return Match.value(event).pipe(
              Match.tag("CallFinalized", (e) =>
                e.depth === 0 ? { ...state, answer: e.answer } : state),
              Match.tag("CallFailed", (e) =>
                e.depth === 0 ? { ...state, failed: true } : state),
              Match.orElse(() => state)
            )
          })
      )
    )

    if (result.failed || !result.answer) {
      process.exitCode = 1
    }

    process.stdout.write(result.answer + "\n")
  })

// --- Layer construction ---

const buildRlmModelLayer = (cliArgs: CliArgs): Layer.Layer<RlmModel, never, never> => {
  const httpLayer = FetchHttpClient.layer
  const subLlmDelegation = {
    enabled: cliArgs.subDelegationEnabled ?? cliArgs.subModel !== undefined,
    depthThreshold: cliArgs.subDelegationDepthThreshold ?? 1
  }

  if (cliArgs.provider === "openai") {
    const clientLayer = OpenAiClient.layer({
      apiKey: Redacted.make(Bun.env.OPENAI_API_KEY!)
    })

    const modelLayer = makeOpenAiRlmModel({
      primaryModel: cliArgs.model,
      ...(cliArgs.subModel !== undefined ? { subModel: cliArgs.subModel } : {}),
      subLlmDelegation
    })

    return Layer.provide(modelLayer, Layer.provide(clientLayer, httpLayer))
  }

  if (cliArgs.provider === "google") {
    const clientLayer = GoogleClient.layer({
      apiKey: Redacted.make(Bun.env.GOOGLE_API_KEY!)
    })

    const modelLayer = makeGoogleRlmModel({
      primaryModel: cliArgs.model,
      ...(cliArgs.subModel !== undefined ? { subModel: cliArgs.subModel } : {}),
      subLlmDelegation
    })

    return Layer.provide(modelLayer, Layer.provide(clientLayer, httpLayer))
  }

  const clientLayer = AnthropicClient.layer({
    apiKey: Redacted.make(Bun.env.ANTHROPIC_API_KEY!)
  })

  const modelLayer = makeAnthropicRlmModel({
    primaryModel: cliArgs.model,
    ...(cliArgs.subModel !== undefined ? { subModel: cliArgs.subModel } : {}),
    subLlmDelegation
  })

  return Layer.provide(modelLayer, Layer.provide(clientLayer, httpLayer))
}

const buildLayer = (cliArgs: CliArgs): Layer.Layer<Rlm, never, never> => {
  const subLlmDelegation = {
    enabled: cliArgs.subDelegationEnabled ?? cliArgs.subModel !== undefined,
    depthThreshold: cliArgs.subDelegationDepthThreshold ?? 1
  }

  const configLayer = Layer.succeed(RlmConfig, {
    maxIterations: cliArgs.maxIterations ?? 50,
    maxDepth: cliArgs.maxDepth ?? 1,
    maxLlmCalls: cliArgs.maxLlmCalls ?? 200,
    maxTotalTokens: null,
    concurrency: 4,
    enableLlmQueryBatched: true,
    maxBatchQueries: 32,
    eventBufferCapacity: 4096,
    maxExecutionOutputChars: 8_000,
    primaryTarget: {
      provider: cliArgs.provider,
      model: cliArgs.model
    },
    ...(cliArgs.subModel !== undefined
      ? {
          subTarget: {
            provider: cliArgs.provider,
            model: cliArgs.subModel
          }
        }
      : {}),
    subLlmDelegation
  })

  const modelLayer = buildRlmModelLayer(cliArgs)

  return Layer.provide(
    rlmBunLayer,
    Layer.mergeAll(modelLayer, configLayer)
  )
}

// --- Entry point ---

const cliArgs = parseArgs()
if (cliArgs) {
  main(cliArgs).pipe(
    Effect.provide(buildLayer(cliArgs)),
    BunRuntime.runMain
  )
}
