import { Effect, Layer } from "effect"
import { LanguageModelClient, type GenerateRequest, type GenerateResponse } from "../LanguageModelClient"
import { UnknownRlmError } from "../RlmError"

export interface FakeModelMetrics {
  calls: number
  readonly requests: Array<GenerateRequest>
}

export const makeFakeLanguageModelClientLayer = (
  responses: ReadonlyArray<GenerateResponse>,
  metrics?: FakeModelMetrics
): Layer.Layer<LanguageModelClient> => {
  let index = 0

  return Layer.succeed(
    LanguageModelClient,
    LanguageModelClient.of({
      generate: Effect.fn("FakeLanguageModelClient.generate")(function*(request) {
        metrics?.requests.push(request)
        if (metrics) {
          metrics.calls += 1
        }

        const scripted = responses[index]
        index += 1

        if (scripted === undefined) {
          return yield* new UnknownRlmError({
            message: "Fake model script exhausted"
          })
        }

        return scripted
      })
    })
  )
}
