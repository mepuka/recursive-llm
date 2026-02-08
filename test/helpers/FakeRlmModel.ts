import * as LanguageModel from "@effect/ai/LanguageModel"
import * as Response from "@effect/ai/Response"
import type * as Prompt from "@effect/ai/Prompt"
import { Effect, Layer } from "effect"
import { RlmModel } from "../../src/RlmModel"
import { UnknownRlmError } from "../../src/RlmError"

export interface FakeModelMetrics {
  calls: number
  readonly prompts: Array<Prompt.Prompt>
  readonly depths: Array<number>
  readonly isSubCalls?: Array<boolean | undefined>
  readonly toolChoices?: Array<unknown>
  readonly disableToolCallResolutions?: Array<boolean | undefined>
}

export interface FakeModelResponse {
  readonly text?: string
  readonly error?: string
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string
    readonly params: unknown
  }>
  readonly totalTokens?: number
}

const makeMinimalResponse = (response: FakeModelResponse) => {
  const parts: Array<Response.PartEncoded> = []

  if (response.text !== undefined) {
    parts.push(Response.makePart("text", { text: response.text }))
  }

  if (response.toolCalls !== undefined) {
    for (let index = 0; index < response.toolCalls.length; index += 1) {
      const toolCall = response.toolCalls[index]!
      parts.push(Response.makePart("tool-call", {
        id: `tool-call-${index}`,
        name: toolCall.name,
        params: toolCall.params,
        providerExecuted: false
      }))
    }
  }

  parts.push(Response.makePart("finish", {
    reason: "stop" as const,
    usage: new Response.Usage({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: response.totalTokens
    })
  }))

  return new LanguageModel.GenerateTextResponse<any>(parts as any)
}

export const makeFakeRlmModelLayer = (
  responses: ReadonlyArray<FakeModelResponse>,
  metrics?: FakeModelMetrics
): Layer.Layer<RlmModel> => {
  let index = 0

  return Layer.succeed(
    RlmModel,
    RlmModel.of({
      generateText: Effect.fn("FakeRlmModel.generateText")(function*({
        prompt,
        depth,
        isSubCall,
        toolChoice,
        disableToolCallResolution
      }) {
        metrics?.prompts.push(prompt)
        metrics?.depths.push(depth)
        metrics?.isSubCalls?.push(isSubCall)
        metrics?.toolChoices?.push(toolChoice)
        metrics?.disableToolCallResolutions?.push(disableToolCallResolution)
        if (metrics) metrics.calls += 1

        const scripted = responses[index]
        index += 1

        if (scripted === undefined) {
          return yield* new UnknownRlmError({ message: "Fake model script exhausted" })
        }

        if (scripted.error !== undefined) {
          return yield* new UnknownRlmError({ message: scripted.error })
        }

        return makeMinimalResponse(scripted)
      })
    })
  )
}
