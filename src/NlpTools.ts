/**
 * NLP tool adapter — bridges effect-nlp's ExportedTool to RlmToolAny.
 *
 * effect-nlp is an optional dependency (git submodule). If not installed,
 * nlpTools returns an empty array instead of failing.
 */

import { Effect } from "effect"
import type { RlmToolAny } from "./RlmTool"
import { RlmToolError } from "./RlmTool"

const loadEffectNlp = Effect.tryPromise({
  try: () => import("effect-nlp") as Promise<typeof import("effect-nlp")>,
  catch: () => null
})

export const nlpTools: Effect.Effect<ReadonlyArray<RlmToolAny>, RlmToolError, never> =
  Effect.gen(function*() {
    const mod = yield* loadEffectNlp
    if (mod === null) return []

    const exported = yield* mod.Tools.exportTools.pipe(
      Effect.mapError(
        (e) => new RlmToolError({ message: e.message, toolName: e.toolName })
      )
    )

    return exported.map((tool): RlmToolAny => ({
      ...tool,
      handle: (args) =>
        tool.handle(args).pipe(
          Effect.mapError(
            (e) => new RlmToolError({ message: e.message, toolName: e.toolName })
          )
        )
    }))
  })
