import { Effect, Match, Stream } from "effect"
import { type CliArgs, buildCliLayer } from "../CliLayer"
import { nlpTools } from "../NlpTools"
import { Rlm } from "../Rlm"
import { formatEvent, type RenderOptions } from "../RlmRenderer"
import type { RlmToolAny } from "../RlmTool"
import { analyzeContext } from "../ContextMetadata"
import * as path from "node:path"

export const runCliProgram = (cliArgs: CliArgs) =>
  Effect.gen(function*() {
    const contextFile = cliArgs.contextFile
    const context = contextFile
      ? yield* Effect.promise(() => Bun.file(contextFile).text())
      : cliArgs.context
    const contextMetadata = context.length > 0
      ? analyzeContext(context, contextFile !== undefined ? path.basename(contextFile) : undefined)
      : undefined

    const tools: ReadonlyArray<RlmToolAny> = cliArgs.nlpTools
      ? yield* nlpTools.pipe(Effect.orDie)
      : []

    const rlm = yield* Rlm

    const renderOpts: RenderOptions = {
      quiet: cliArgs.quiet,
      noColor: cliArgs.noColor
    }

    const result = yield* rlm.stream({
      query: cliArgs.query,
      context,
      ...(contextMetadata !== undefined ? { contextMetadata } : {}),
      tools
    }).pipe(
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

export const runCliWithLayer = (cliArgs: CliArgs) =>
  runCliProgram(cliArgs).pipe(Effect.provide(buildCliLayer(cliArgs)))
