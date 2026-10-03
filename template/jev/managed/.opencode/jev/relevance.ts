// Оценка релевантности фрагментов вывода тула задаче через Jev.
import { batches, type Chunk } from "./chunks.ts"
import { noul, type Decide, type Question } from "./client.ts"
import type { TaskContext } from "./context.ts"
import type { Settings } from "./settings.ts"

export type RelevanceInput = {
  readonly decide: Decide
  readonly context: TaskContext
  readonly source: string
  readonly chunks: readonly Chunk[]
  readonly budget: Pick<Settings["filter"], "stateCharBudget" | "maxQuestionsPerRequest">
}

export type RelevanceResult =
  | {
      readonly ok: true
      // Вероятность «фрагмент нужен для задачи» по индексу фрагмента.
      readonly probabilities: ReadonlyMap<number, number>
      readonly ms: number
      readonly inputTokens: number
    }
  | { readonly ok: false; readonly reason: string }

const question = (id: string): Question => ({
  type: "noul",
  instructions: `Нужен ли фрагмент \`chunks.${id}\` из \`source\` агенту для выполнения задачи \`task\` с учетом его намерения \`intent\`? Да — если фрагмент содержит сведения, код или записи, которые относятся к задаче.`,
})

export async function scoreRelevance(input: RelevanceInput): Promise<RelevanceResult> {
  const fixed = input.context.task.length + input.context.intent.length + input.source.length + 600
  // Пакеты отправляются параллельно: каждый укладывается в лимит state провайдера.
  const outcomes = await Promise.all(
    batches(input.chunks, fixed, input.budget).map(async (batch) => {
      const outcome = await input.decide({
        state: {
          task: input.context.task,
          intent: input.context.intent,
          source: input.source,
          chunks: Object.fromEntries(batch.map((chunk) => [`c${chunk.index}`, chunk.text])),
        },
        questions: Object.fromEntries(batch.map((chunk) => [`c${chunk.index}`, question(`c${chunk.index}`)])),
      })
      return { batch, outcome }
    }),
  )
  const probabilities = new Map<number, number>()
  let ms = 0
  let inputTokens = 0
  for (const { batch, outcome } of outcomes) {
    if (!outcome.ok) return { ok: false, reason: outcome.reason }
    ms = Math.max(ms, outcome.ms)
    inputTokens += outcome.inputTokens
    for (const chunk of batch) {
      const probability = noul(outcome, `c${chunk.index}`)
      if (probability === undefined) return { ok: false, reason: "missing_answer" }
      probabilities.set(chunk.index, probability)
    }
  }
  return { ok: true, probabilities, ms, inputTokens }
}
