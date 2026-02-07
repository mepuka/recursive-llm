import { Effect, Layer } from "effect"
import { SandboxFactory } from "../Sandbox"

export interface FakeSandboxMetrics {
  createCalls: number
  executeCalls: number
  readonly snippets: Array<string>
}

export const makeFakeSandboxFactoryLayer = (
  metrics?: FakeSandboxMetrics
): Layer.Layer<SandboxFactory> =>
  Layer.succeed(
    SandboxFactory,
    SandboxFactory.of({
      create: () => {
        if (metrics) {
          metrics.createCalls += 1
        }

        const vars = new Map<string, unknown>()

        return Effect.succeed({
          execute: Effect.fn("FakeSandbox.execute")(function*(code: string) {
            metrics?.snippets.push(code)
            if (metrics) {
              metrics.executeCalls += 1
            }
            return `executed:${code.length}`
          }),
          setVariable: Effect.fn("FakeSandbox.setVariable")(function*(name: string, value: unknown) {
            vars.set(name, value)
          }),
          getVariable: Effect.fn("FakeSandbox.getVariable")(function*(name: string) {
            return vars.get(name)
          })
        })
      }
    })
  )
