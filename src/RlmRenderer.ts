import { Match } from "effect"
import type { RlmEvent } from "./RlmTypes"

export interface RenderOptions {
  readonly quiet?: boolean
  readonly showCode?: boolean
  readonly showOutput?: boolean
  readonly noColor?: boolean
}

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const MAGENTA = "\x1b[35m"

const c = (code: string, text: string, noColor?: boolean) =>
  noColor ? text : `${code}${text}${RESET}`

const indent = (depth: number) => "  ".repeat(depth)

export const renderEvent = (
  event: RlmEvent,
  out: { write: (s: string) => void },
  options?: RenderOptions
): void => {
  const nc = options?.noColor
  const quiet = options?.quiet ?? false
  const showCode = options?.showCode ?? true
  const showOutput = options?.showOutput ?? true

  Match.value(event).pipe(
    Match.tagsExhaustive({
      IterationStarted: (e) => {
        if (quiet) return
        out.write(
          `${indent(e.depth)}${c(DIM, `--- Iteration ${e.iteration} --- (budget: ${e.budget.iterationsRemaining}i, ${e.budget.llmCallsRemaining}c)`, nc)}\n`
        )
      },
      ModelResponse: (e) => {
        if (quiet) return
        const truncated = e.text.length > 200
          ? e.text.slice(0, 200) + "..."
          : e.text
        out.write(`${indent(e.depth)}${c(DIM, truncated, nc)}\n`)
      },
      CodeExecutionStarted: (e) => {
        if (quiet || !showCode) return
        out.write(`${indent(e.depth)}${c(YELLOW, "> Executing code...", nc)}\n`)
      },
      CodeExecutionCompleted: (e) => {
        if (quiet || !showOutput) return
        const truncatedOutput = e.output.length > 500
          ? e.output.slice(0, 500) + "..."
          : e.output
        out.write(`${indent(e.depth)}${c(GREEN, `< Output: ${truncatedOutput}`, nc)}\n`)
      },
      BridgeCallReceived: (e) => {
        if (quiet) return
        out.write(`${indent(e.depth)}${c(MAGENTA, `Bridge: ${e.method}`, nc)}\n`)
      },
      CallFinalized: (e) => {
        const truncatedAnswer = e.answer.length > 200
          ? e.answer.slice(0, 200) + "..."
          : e.answer
        out.write(`${indent(e.depth)}${c(BOLD + GREEN, `FINAL: ${truncatedAnswer}`, nc)}\n`)
      },
      CallFailed: (e) => {
        const err = e.error
        out.write(
          `${indent(e.depth)}${c(RED, `FAILED: ${err._tag}: ${"message" in err ? err.message : ""}`, nc)}\n`
        )
      },
      SchedulerWarning: (e) => {
        if (quiet) return
        out.write(`${c(YELLOW, `WARN: ${e.message}`, nc)}\n`)
      },
      CallStarted: (_) => {
        if (quiet) return
      }
    })
  )
}
