import { AnthropicClient } from "@effect/ai-anthropic"
import { GoogleClient } from "@effect/ai-google"
import { OpenAiClient } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { Layer, Redacted } from "effect"
import { Rlm, rlmBunLayer } from "./Rlm"
import { RlmConfig, type RlmConfigService, type RlmProvider } from "./RlmConfig"
import type { RlmModel } from "./RlmModel"
import { makeAnthropicRlmModel, makeGoogleRlmModel, makeOpenAiRlmModel } from "./RlmModel"

export interface CliArgs {
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
  nlpTools: boolean
}

export const buildRlmModelLayer = (cliArgs: CliArgs): Layer.Layer<RlmModel, never, never> => {
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

export const makeCliConfig = (cliArgs: CliArgs): RlmConfigService => {
  const subLlmDelegation = {
    enabled: cliArgs.subDelegationEnabled ?? cliArgs.subModel !== undefined,
    depthThreshold: cliArgs.subDelegationDepthThreshold ?? 1
  }

  return {
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
  }
}

export const buildCliLayer = (cliArgs: CliArgs): Layer.Layer<Rlm, never, never> => {
  const modelLayer = buildRlmModelLayer(cliArgs)
  const configLayer = Layer.succeed(RlmConfig, makeCliConfig(cliArgs))

  return Layer.provide(
    rlmBunLayer,
    Layer.mergeAll(modelLayer, configLayer)
  )
}
