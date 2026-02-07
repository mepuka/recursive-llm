import { Context, Effect } from "effect"
import type { RlmError } from "./RlmError"

export interface GenerateRequest {
  readonly query: string
  readonly context: string
  readonly depth: number
  readonly iteration: number
  readonly transcript: ReadonlyArray<string>
}

export interface GenerateResponse {
  readonly text: string
  readonly totalTokens?: number
}

export class LanguageModelClient extends Context.Tag("@recursive-llm/LanguageModelClient")<
  LanguageModelClient,
  {
    readonly generate: (request: GenerateRequest) => Effect.Effect<GenerateResponse, RlmError>
  }
>() {}
