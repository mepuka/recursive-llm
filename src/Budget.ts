import { Effect, Option, Ref } from "effect"
import { BudgetExhaustedError } from "./RlmError"
import { RlmRuntime } from "./Runtime"
import { BudgetState, type CallId } from "./RlmTypes"

export const consumeIteration = Effect.fn("Budget.consumeIteration")(function*(
  callId: CallId
) {
  const { budgetRef } = yield* RlmRuntime
  const allowed = yield* Ref.modify(budgetRef, (state) => {
    if (state.iterationsRemaining <= 0) {
      return [false, state] as const
    }
    return [true, new BudgetState({ ...state, iterationsRemaining: state.iterationsRemaining - 1 })] as const
  })

  if (!allowed) {
    return yield* new BudgetExhaustedError({
      resource: "iterations",
      callId,
      remaining: 0
    })
  }
})

export const reserveLlmCall = Effect.fn("Budget.reserveLlmCall")(function*(
  callId: CallId
) {
  const { budgetRef } = yield* RlmRuntime
  const allowed = yield* Ref.modify(budgetRef, (state) => {
    if (state.llmCallsRemaining <= 0) {
      return [false, state] as const
    }
    return [true, new BudgetState({ ...state, llmCallsRemaining: state.llmCallsRemaining - 1 })] as const
  })

  if (!allowed) {
    return yield* new BudgetExhaustedError({
      resource: "llmCalls",
      callId,
      remaining: 0
    })
  }
})

export const recordTokens = Effect.fn("Budget.recordTokens")(function*(
  callId: CallId,
  totalTokens: number | undefined
) {
  if (totalTokens === undefined) {
    return
  }

  const { budgetRef } = yield* RlmRuntime
  const allowed = yield* Ref.modify(budgetRef, (state) => {
    if (Option.isNone(state.tokenBudgetRemaining)) {
      return [true, state] as const
    }
    if (state.tokenBudgetRemaining.value < totalTokens) {
      return [false, state] as const
    }
    return [
      true,
      new BudgetState({
        ...state,
        tokenBudgetRemaining: Option.some(state.tokenBudgetRemaining.value - totalTokens)
      })
    ] as const
  })

  if (!allowed) {
    return yield* new BudgetExhaustedError({
      resource: "tokens",
      callId,
      remaining: 0
    })
  }
})

export const snapshot = Effect.gen(function*() {
  const { budgetRef } = yield* RlmRuntime
  return yield* Ref.get(budgetRef)
})

export const withLlmPermit = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | RlmRuntime> =>
  Effect.flatMap(RlmRuntime, (runtime) =>
    runtime.llmSemaphore.withPermits(1)(effect)
  )
