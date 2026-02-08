import { Effect, JSONSchema, Schema } from "effect"

export class RlmToolError extends Schema.TaggedError<RlmToolError>()(
  "RlmToolError",
  {
    message: Schema.String,
    toolName: Schema.String
  }
) {}

// Reserved words that cannot be used as function parameter names
const RESERVED_PARAM_NAMES = new Set([
  "print", "__vars", "llm_query", "llm_query_batched", "__strictScope",
  // JS reserved words
  "break", "case", "catch", "continue", "debugger", "default", "delete",
  "do", "else", "finally", "for", "function", "if", "in", "instanceof",
  "new", "return", "switch", "this", "throw", "try", "typeof", "var",
  "void", "while", "with", "class", "const", "enum", "export", "extends",
  "import", "super", "implements", "interface", "let", "package", "private",
  "protected", "public", "static", "yield", "await", "async"
])

const JS_IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

export const isValidToolName = (name: string): boolean =>
  JS_IDENTIFIER_RE.test(name) && !RESERVED_PARAM_NAMES.has(name)

export interface RlmToolAny {
  readonly name: string
  readonly description: string
  readonly parameterNames: ReadonlyArray<string>
  readonly parametersJsonSchema: object
  readonly returnsJsonSchema: object
  readonly timeoutMs: number
  readonly handle: (args: ReadonlyArray<unknown>) => Effect.Effect<unknown, RlmToolError>
}

export const make = <P extends Schema.Struct.Fields, A, I>(
  name: string,
  options: {
    readonly description: string
    readonly parameters: P
    readonly returns: Schema.Schema<A, I, never>
    readonly timeoutMs?: number
    readonly handler: (params: Schema.Struct.Type<P>) => Effect.Effect<A, RlmToolError>
  }
): RlmToolAny => {
  if (!isValidToolName(name)) {
    throw new Error(
      `Invalid tool name "${name}": must be a valid JS identifier and not a reserved word or sandbox binding`
    )
  }

  const paramSchema = Schema.Struct(options.parameters) as unknown as Schema.Schema<Schema.Struct.Type<P>, Schema.Struct.Encoded<P>, never>
  const parameterNames = Object.keys(options.parameters)
  const parametersJsonSchema = JSONSchema.make(paramSchema)
  const returnsJsonSchema = JSONSchema.make(options.returns)
  const timeoutMs = options.timeoutMs ?? 30_000

  return {
    name,
    description: options.description,
    parameterNames,
    parametersJsonSchema,
    returnsJsonSchema,
    timeoutMs,
    handle: (args: ReadonlyArray<unknown>): Effect.Effect<unknown, RlmToolError> => {
      // Build object from positional args + parameter names
      const obj: Record<string, unknown> = {}
      for (let i = 0; i < parameterNames.length; i++) {
        obj[parameterNames[i]!] = args[i]
      }

      return Schema.decodeUnknown(paramSchema)(obj).pipe(
        Effect.mapError((e) => new RlmToolError({
          message: `Parameter validation failed for tool ${name}: ${String(e)}`,
          toolName: name
        })),
        Effect.flatMap((decoded) => options.handler(decoded as Schema.Struct.Type<P>)),
        Effect.flatMap((result) =>
          Schema.encode(options.returns)(result as any).pipe(
            Effect.mapError((e) => new RlmToolError({
              message: `Return value encoding failed for tool ${name}: ${String(e)}`,
              toolName: name
            }))
          )
        )
      )
    }
  }
}
