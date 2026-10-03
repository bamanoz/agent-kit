// Фильтр вывода read и командных тулов: скрывает фрагменты, которые Jev счел ненужными для задачи.
import {
  assemble,
  mentionsAny,
  outputMarker,
  parseReadOutput,
  readMarker,
  splitChunks,
  taskIdentifiers,
  type Chunk,
} from "./chunks.ts"
import type { Decide } from "./client.ts"
import type { TaskContext } from "./context.ts"
import { scoreRelevance } from "./relevance.ts"
import type { Settings } from "./settings.ts"

export type FilterKind = "read" | "output"

export type FilterInput = {
  readonly kind: FilterKind
  readonly source: string
  readonly output: string
  readonly context: TaskContext
  readonly decide: Decide
  readonly settings: Settings["filter"]
}

export type FilterResult =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string }
  | {
      readonly kind: "filtered"
      readonly output: string
      readonly chunks: number
      readonly hidden: number
      readonly scores: Readonly<Record<string, number>>
      readonly jevMs: number
      readonly jevInputTokens: number
    }

// Строки, которые в выводе команд важны всегда: ошибки, падения тестов, итоги.
const SIGNAL = /error|fail|exception|warn|ошибк|предупрежд|passed|total|итог|exit code|traceback|panic/i

type Split = {
  readonly chunks: readonly Chunk[]
  readonly pinned: ReadonlySet<number>
  readonly render: (body: string) => string
  readonly marker: (chunk: Chunk, probability: number) => string
}

function splitOutput(input: FilterInput): Split | undefined {
  const identifiers = taskIdentifiers(`${input.context.task}\n${input.context.intent}`, input.settings.pinPatterns)
  const pinByTask = (chunk: Chunk): boolean => mentionsAny(chunk.text, identifiers)
  switch (input.kind) {
    case "read": {
      const parsed = parseReadOutput(input.output)
      if (parsed === undefined) return undefined
      const chunks = splitChunks(parsed.lines, input.settings)
      // Первый фрагмент (заголовок, импорты) и фрагменты с идентификаторами задачи не скрываются.
      const pinned = new Set(chunks.filter((chunk) => chunk.index === 0 || pinByTask(chunk)).map((chunk) => chunk.index))
      return { chunks, pinned, render: (body) => `${parsed.head}${body}${parsed.tail}`, marker: readMarker }
    }
    case "output": {
      const chunks = splitChunks(input.output.split("\n"), input.settings)
      const last = chunks.length - 1
      const pinned = new Set(
        chunks
          .filter((chunk) => chunk.index === 0 || chunk.index === last || SIGNAL.test(chunk.text) || pinByTask(chunk))
          .map((chunk) => chunk.index),
      )
      return { chunks, pinned, render: (body) => body, marker: outputMarker }
    }
  }
}

const charsOf = (chunks: readonly Chunk[]): number => chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)

export async function filterOutput(input: FilterInput): Promise<FilterResult> {
  const split = splitOutput(input)
  if (split === undefined) return { kind: "skip", reason: "unparsed_output" }
  const minSaving = input.output.length * input.settings.minSavingRatio
  const candidates = split.chunks.filter((chunk) => !split.pinned.has(chunk.index))
  // Если даже скрытие всех кандидатов мало что даст, Jev не вызывается.
  if (charsOf(candidates) < minSaving) return { kind: "skip", reason: "pinned_majority" }

  const relevance = await scoreRelevance({
    decide: input.decide,
    context: input.context,
    source: input.source,
    chunks: candidates,
    budget: input.settings,
  })
  if (!relevance.ok) return { kind: "error", reason: relevance.reason }

  const scores: Record<string, number> = {}
  const hidden = new Map<number, number>()
  for (const [index, probability] of relevance.probabilities) {
    scores[`c${index}`] = Math.round(probability * 100) / 100
    if (probability < input.settings.keepThreshold) hidden.set(index, probability)
  }
  if (charsOf(split.chunks.filter((chunk) => hidden.has(chunk.index))) < minSaving) return { kind: "skip", reason: "low_saving" }

  const notice = `[Фильтр Jev скрыл ${hidden.size} из ${split.chunks.length} фрагментов как, вероятно, не относящиеся к задаче. Если нужных сведений нет в показанном тексте, сначала прочитай скрытые диапазоны по пометкам ниже и только потом делай вывод об их отсутствии.]\n`
  return {
    kind: "filtered",
    output: split.render(notice + assemble(split.chunks, hidden, split.marker)),
    chunks: split.chunks.length,
    hidden: hidden.size,
    scores,
    jevMs: relevance.ms,
    jevInputTokens: relevance.inputTokens,
  }
}
