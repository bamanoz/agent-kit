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
export type LineRange = readonly [number, number]

export type FilterInput = {
  readonly kind: FilterKind
  readonly source: string
  readonly output: string
  readonly context: TaskContext
  readonly decide: Decide
  readonly settings: Settings["filter"]
}

// Разбор вывода на фрагменты: какие закреплены, какие отправляются в Jev.
export type FilterPlan = {
  readonly chunks: readonly Chunk[]
  readonly pinned: ReadonlySet<number>
  readonly candidates: readonly Chunk[]
  // Номера строк файла (read) или строк вывода (output), с 1, включительно.
  readonly range: (chunk: Chunk) => LineRange
  readonly render: (body: string) => string
  readonly marker: (chunk: Chunk, probability: number) => string
}

export type FilterResult =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string }
  | {
      readonly kind: "filtered"
      readonly output: string
      readonly chunks: number
      readonly hidden: number
      readonly hiddenRanges: readonly LineRange[]
      readonly scores: Readonly<Record<string, number>>
      readonly jevMs: number
      readonly jevInputTokens: number
    }

// Строки, которые в выводе команд важны всегда: ошибки, падения тестов, итоги.
const SIGNAL = /error|fail|exception|warn|ошибк|предупрежд|passed|total|итог|exit code|traceback|panic/i

const lineOf = (line: string | undefined): number => Number.parseInt(line ?? "0", 10)

export function planFilter(kind: FilterKind, output: string, context: TaskContext, settings: Settings["filter"]): FilterPlan | undefined {
  const identifiers = taskIdentifiers(`${context.task}\n${context.intent}`, settings.pinPatterns)
  const pinByTask = (chunk: Chunk): boolean => mentionsAny(chunk.text, identifiers)
  const withCandidates = (plan: Omit<FilterPlan, "candidates">): FilterPlan => ({
    ...plan,
    candidates: plan.chunks.filter((chunk) => !plan.pinned.has(chunk.index)),
  })
  switch (kind) {
    case "read": {
      const parsed = parseReadOutput(output)
      if (parsed === undefined) return undefined
      const chunks = splitChunks(parsed.lines, settings)
      // Первый фрагмент (заголовок, импорты) и фрагменты с идентификаторами задачи не скрываются.
      const pinned = new Set(chunks.filter((chunk) => chunk.index === 0 || pinByTask(chunk)).map((chunk) => chunk.index))
      return withCandidates({
        chunks,
        pinned,
        range: (chunk) => [lineOf(chunk.lines[0]), lineOf(chunk.lines[chunk.lines.length - 1])],
        render: (body) => `${parsed.head}${body}${parsed.tail}`,
        marker: readMarker,
      })
    }
    case "output": {
      const chunks = splitChunks(output.split("\n"), settings)
      const last = chunks.length - 1
      const starts = chunks.map((chunk) => chunks.slice(0, chunk.index).reduce((sum, item) => sum + item.lines.length, 1))
      const pinned = new Set(
        chunks
          .filter((chunk) => chunk.index === 0 || chunk.index === last || SIGNAL.test(chunk.text) || pinByTask(chunk))
          .map((chunk) => chunk.index),
      )
      return withCandidates({
        chunks,
        pinned,
        range: (chunk) => [starts[chunk.index] ?? 1, (starts[chunk.index] ?? 1) + chunk.lines.length - 1],
        render: (body) => body,
        marker: outputMarker,
      })
    }
  }
}

const charsOf = (chunks: readonly Chunk[]): number => chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)

// Если даже скрытие всех кандидатов мало что даст, Jev не вызывается.
export const worthAsking = (plan: FilterPlan, outputChars: number, settings: Settings["filter"]): boolean =>
  charsOf(plan.candidates) >= outputChars * settings.minSavingRatio

// Скрываемые фрагменты при заданном пороге; undefined — экономия ниже минимальной, вывод не меняется.
export function hiddenAt(
  plan: FilterPlan,
  probabilities: ReadonlyMap<number, number>,
  threshold: number,
  minSavingChars: number,
): ReadonlyMap<number, number> | undefined {
  const hidden = new Map([...probabilities].filter(([, probability]) => probability < threshold))
  return charsOf(plan.chunks.filter((chunk) => hidden.has(chunk.index))) < minSavingChars ? undefined : hidden
}

export async function filterOutput(input: FilterInput): Promise<FilterResult> {
  const plan = planFilter(input.kind, input.output, input.context, input.settings)
  if (plan === undefined) return { kind: "skip", reason: "unparsed_output" }
  if (!worthAsking(plan, input.output.length, input.settings)) return { kind: "skip", reason: "pinned_majority" }

  const relevance = await scoreRelevance({
    decide: input.decide,
    context: input.context,
    source: input.source,
    chunks: plan.candidates,
    budget: input.settings,
  })
  if (!relevance.ok) return { kind: "error", reason: relevance.reason }

  const hidden = hiddenAt(plan, relevance.probabilities, input.settings.keepThreshold, input.output.length * input.settings.minSavingRatio)
  if (hidden === undefined) return { kind: "skip", reason: "low_saving" }

  const scores = Object.fromEntries([...relevance.probabilities].map(([index, p]) => [`c${index}`, Math.round(p * 100) / 100]))
  const notice = `[Фильтр Jev скрыл ${hidden.size} из ${plan.chunks.length} фрагментов как, вероятно, не относящиеся к задаче. Если нужных сведений нет в показанном тексте, сначала прочитай скрытые диапазоны по пометкам ниже и только потом делай вывод об их отсутствии.]\n`
  return {
    kind: "filtered",
    output: plan.render(notice + assemble(plan.chunks, hidden, plan.marker)),
    chunks: plan.chunks.length,
    hidden: hidden.size,
    hiddenRanges: plan.chunks.filter((chunk) => hidden.has(chunk.index)).map(plan.range),
    scores,
    jevMs: relevance.ms,
    jevInputTokens: relevance.inputTokens,
  }
}
