import { Context, Effect, Layer, Scope } from "effect"
import { SandboxError } from "./RlmError"
import type { CallId } from "./RlmTypes"

export interface SandboxConfigService {
  readonly sandboxMode: "permissive" | "strict"
  readonly executeTimeoutMs: number
  readonly setVarTimeoutMs: number
  readonly getVarTimeoutMs: number
  readonly shutdownGraceMs: number
  readonly maxFrameBytes: number
  readonly maxBridgeConcurrency: number
  readonly incomingFrameQueueCapacity: number
  readonly workerPath: string
}

export interface SandboxInstance {
  readonly execute: (code: string) => Effect.Effect<string, SandboxError>
  readonly setVariable: (name: string, value: unknown) => Effect.Effect<void, SandboxError>
  readonly getVariable: (name: string) => Effect.Effect<unknown, SandboxError>
}

export class SandboxFactory extends Context.Tag("@recursive-llm/SandboxFactory")<
  SandboxFactory,
  {
    readonly create: (options: {
      readonly callId: CallId
      readonly depth: number
    }) => Effect.Effect<SandboxInstance, SandboxError, Scope.Scope>
  }
>() {}

export class SandboxConfig extends Context.Reference<SandboxConfig>()(
  "@recursive-llm/SandboxConfig",
  {
    defaultValue: (): SandboxConfigService => ({
      sandboxMode: "permissive",
      executeTimeoutMs: 30_000,
      setVarTimeoutMs: 5_000,
      getVarTimeoutMs: 5_000,
      shutdownGraceMs: 2_000,
      maxFrameBytes: 4 * 1024 * 1024,
      maxBridgeConcurrency: 4,
      incomingFrameQueueCapacity: 2_048,
      workerPath: new URL("./sandbox-worker.ts", import.meta.url).pathname
    })
  }
) {}

export const noopSandboxFactoryLayer = Layer.succeed(
  SandboxFactory,
  SandboxFactory.of({
    create: () =>
      Effect.succeed({
        execute: () => Effect.succeed(""),
        setVariable: () => Effect.void,
        getVariable: () => Effect.void
      })
  })
)
