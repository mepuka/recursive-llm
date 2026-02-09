import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import type { CliArgs } from "../CliLayer"
import type { RlmProvider } from "../RlmConfig"
import { type ParsedCliConfig, normalizeCliArgs } from "./Normalize"
import { runCliWithLayer } from "./Run"

const PROVIDERS = ["anthropic", "openai", "google"] as const

const query = Args.text({ name: "query" }).pipe(
  Args.withDescription("Prompt query")
)

const context = Options.text("context").pipe(
  Options.withDefault(""),
  Options.withDescription("Context string")
)

const contextFile = Options.text("context-file").pipe(
  Options.optional,
  Options.withDescription("Read context from file")
)

const provider = Options.choice("provider", PROVIDERS).pipe(
  Options.withDefault("anthropic"),
  Options.withDescription("Provider: anthropic, openai, google")
)

const model = Options.text("model").pipe(
  Options.withDefault("claude-sonnet-4-5-20250929"),
  Options.withDescription("Model name")
)

const subModel = Options.text("sub-model").pipe(
  Options.optional,
  Options.withDescription("Lower-tier model for delegated sub-LLM calls")
)

const subDelegationEnabled = Options.boolean("sub-delegation-enabled").pipe(
  Options.withDescription("Enable sub-LLM delegation")
)

const disableSubDelegation = Options.boolean("disable-sub-delegation").pipe(
  Options.withDescription("Disable sub-LLM delegation")
)

const subDelegationDepthThreshold = Options.integer("sub-delegation-depth-threshold").pipe(
  Options.optional,
  Options.withDescription("Minimum depth required to delegate to sub-model")
)

const maxIterations = Options.integer("max-iterations").pipe(
  Options.optional,
  Options.withDescription("Max iterations")
)

const maxDepth = Options.integer("max-depth").pipe(
  Options.optional,
  Options.withDescription("Max recursion depth")
)

const maxLlmCalls = Options.integer("max-llm-calls").pipe(
  Options.optional,
  Options.withDescription("Max total LLM calls")
)

const quiet = Options.boolean("quiet").pipe(
  Options.withDescription("Only show final answer and errors")
)

const noColor = Options.boolean("no-color").pipe(
  Options.withDescription("Disable ANSI colors")
)

const nlpTools = Options.boolean("nlp-tools").pipe(
  Options.withDescription("Enable built-in NLP tools (DocumentStats, ChunkBySentences, ExtractEntities, etc.)")
)

const commandConfig = {
  query,
  context,
  contextFile,
  provider,
  model,
  subModel,
  subDelegationEnabled,
  disableSubDelegation,
  subDelegationDepthThreshold,
  maxIterations,
  maxDepth,
  maxLlmCalls,
  quiet,
  noColor,
  nlpTools
}

export type CliExecutor = (cliArgs: CliArgs) => Effect.Effect<void>

type CliCommandEnv = Record<string, string | undefined>

export interface RunCliCommandOptions {
  readonly execute?: CliExecutor
  readonly env?: CliCommandEnv
  readonly name?: string
  readonly version?: string
}

const defaultExecute: CliExecutor = runCliWithLayer

export const makeCliCommand = (
  rawArgs: ReadonlyArray<string>,
  options: Pick<RunCliCommandOptions, "execute" | "env"> = {}
) => {
  const execute = options.execute ?? defaultExecute
  const env = options.env ?? Bun.env

  return Command.make("recursive-llm", commandConfig, (parsed) =>
    normalizeCliArgs(parsed as ParsedCliConfig, rawArgs, env).pipe(
      Effect.flatMap(execute)
    ))
}

export const runCliCommand = (
  argv: ReadonlyArray<string>,
  options: RunCliCommandOptions = {}
) =>
  Command.run(makeCliCommand(argv.slice(2), options), {
    name: options.name ?? "recursive-llm",
    version: options.version ?? "0.0.0"
  })(argv)

export type CliProviderOption = (typeof PROVIDERS)[number]
export const isCliProvider = (value: string): value is RlmProvider =>
  PROVIDERS.includes(value as CliProviderOption)
