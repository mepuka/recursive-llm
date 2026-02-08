import * as LanguageModel from "@effect/ai/LanguageModel"
import type * as Prompt from "@effect/ai/Prompt"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import type { AnthropicClient } from "@effect/ai-anthropic/AnthropicClient"
import * as GoogleLanguageModel from "@effect/ai-google/GoogleLanguageModel"
import type { GoogleClient } from "@effect/ai-google/GoogleClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import type { OpenAiClient } from "@effect/ai-openai/OpenAiClient"
import { Context, Effect, Layer } from "effect"
import type { RlmError } from "./RlmError"
import { UnknownRlmError } from "./RlmError"

// --- Service interface ---

export interface RlmModelService {
  readonly generateText: (options: {
    readonly prompt: Prompt.Prompt
    readonly depth: number
    readonly isSubCall?: boolean
    readonly toolkit?: LanguageModel.GenerateTextOptions<any>["toolkit"]
    readonly toolChoice?: LanguageModel.GenerateTextOptions<any>["toolChoice"]
    readonly disableToolCallResolution?: boolean
    readonly concurrency?: LanguageModel.GenerateTextOptions<any>["concurrency"]
  }) => Effect.Effect<LanguageModel.GenerateTextResponse<any>, RlmError>
}

export class RlmModel extends Context.Tag("@recursive-llm/RlmModel")<
  RlmModel,
  RlmModelService
>() {}

export interface SubLlmDelegationOptions {
  readonly enabled: boolean
  readonly depthThreshold: number
}

// --- Layer constructor ---

export const makeRlmModelLayer = <RPrimary, RSub = never>(options: {
  readonly primary: Effect.Effect<LanguageModel.Service, never, RPrimary>
  readonly sub?: Effect.Effect<LanguageModel.Service, never, RSub>
  readonly subLlmDelegation?: SubLlmDelegationOptions
}): Layer.Layer<RlmModel, never, RPrimary | RSub> =>
  Layer.effect(RlmModel, Effect.gen(function*() {
    const primaryLm = yield* options.primary
    const hasSubModel = options.sub !== undefined
    const subLm = hasSubModel ? yield* options.sub! : primaryLm
    const subLlmDelegation: SubLlmDelegationOptions = options.subLlmDelegation ?? {
      enabled: hasSubModel,
      depthThreshold: 1
    }

    return RlmModel.of({
      generateText: ({ prompt, depth, isSubCall, toolkit, toolChoice, disableToolCallResolution, concurrency }) => {
        const useSubModel =
          hasSubModel &&
          subLlmDelegation.enabled &&
          isSubCall === true &&
          depth >= subLlmDelegation.depthThreshold

        const lm = useSubModel ? subLm : primaryLm

        return lm.generateText({
          prompt,
          ...(toolkit !== undefined ? { toolkit } : {}),
          ...(toolChoice !== undefined ? { toolChoice } : {}),
          ...(disableToolCallResolution !== undefined
            ? { disableToolCallResolution }
            : {}),
          ...(concurrency !== undefined ? { concurrency } : {})
        }).pipe(
          Effect.mapError((err) =>
            new UnknownRlmError({ message: `Model error: ${err}`, cause: err })
          )
        )
      }
    })
  }))

// --- Provider convenience constructors ---

export const makeAnthropicRlmModel = (options: {
  readonly primaryModel: string
  readonly primaryConfig?: Omit<AnthropicLanguageModel.Config.Service, "model">
  readonly subModel?: string
  readonly subConfig?: Omit<AnthropicLanguageModel.Config.Service, "model">
  readonly subLlmDelegation?: SubLlmDelegationOptions
}): Layer.Layer<RlmModel, never, AnthropicClient> =>
  makeRlmModelLayer({
    primary: AnthropicLanguageModel.make({
      model: options.primaryModel,
      ...(options.primaryConfig !== undefined
        ? { config: options.primaryConfig }
        : {})
    }),
    ...(options.subModel !== undefined
      ? {
          sub: AnthropicLanguageModel.make({
            model: options.subModel,
            ...((options.subConfig ?? options.primaryConfig) !== undefined
              ? { config: (options.subConfig ?? options.primaryConfig)! }
              : {})
          })
        }
      : {}),
    ...(options.subLlmDelegation !== undefined
      ? { subLlmDelegation: options.subLlmDelegation }
      : {})
  })

export const makeGoogleRlmModel = (options: {
  readonly primaryModel: string
  readonly primaryConfig?: Omit<GoogleLanguageModel.Config.Service, "model">
  readonly subModel?: string
  readonly subConfig?: Omit<GoogleLanguageModel.Config.Service, "model">
  readonly subLlmDelegation?: SubLlmDelegationOptions
}): Layer.Layer<RlmModel, never, GoogleClient> =>
  makeRlmModelLayer({
    primary: GoogleLanguageModel.make({
      model: options.primaryModel,
      ...(options.primaryConfig !== undefined
        ? { config: options.primaryConfig }
        : {})
    }),
    ...(options.subModel !== undefined
      ? {
          sub: GoogleLanguageModel.make({
            model: options.subModel,
            ...((options.subConfig ?? options.primaryConfig) !== undefined
              ? { config: (options.subConfig ?? options.primaryConfig)! }
              : {})
          })
        }
      : {}),
    ...(options.subLlmDelegation !== undefined
      ? { subLlmDelegation: options.subLlmDelegation }
      : {})
  })

export const makeOpenAiRlmModel = (options: {
  readonly primaryModel: string
  readonly primaryConfig?: Omit<OpenAiLanguageModel.Config.Service, "model">
  readonly subModel?: string
  readonly subConfig?: Omit<OpenAiLanguageModel.Config.Service, "model">
  readonly subLlmDelegation?: SubLlmDelegationOptions
}): Layer.Layer<RlmModel, never, OpenAiClient> =>
  makeRlmModelLayer({
    primary: OpenAiLanguageModel.make({
      model: options.primaryModel,
      ...(options.primaryConfig !== undefined
        ? { config: options.primaryConfig }
        : {})
    }),
    ...(options.subModel !== undefined
      ? {
          sub: OpenAiLanguageModel.make({
            model: options.subModel,
            ...((options.subConfig ?? options.primaryConfig) !== undefined
              ? { config: (options.subConfig ?? options.primaryConfig)! }
              : {})
          })
        }
      : {}),
    ...(options.subLlmDelegation !== undefined
      ? { subLlmDelegation: options.subLlmDelegation }
      : {})
  })
