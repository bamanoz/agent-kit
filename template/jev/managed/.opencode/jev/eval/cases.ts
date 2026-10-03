// Оценка одного случая из истории: фильтр вывода read/bash и проверка отчета субагента.
import type { Decide } from "../client.ts"
import type { TaskContext } from "../context.ts"
import { planFilter, worthAsking, type FilterKind, type LineRange } from "../filters.ts"
import { scoreRelevance } from "../relevance.ts"
import type { Settings } from "../settings.ts"
import { checkSubagent } from "../subagent.ts"
import { collectEvidence } from "./evidence.ts"
import type { ToolEvent } from "./history.ts"

export type FilterCase = {
  readonly kind: "filter"
  readonly filter: FilterKind
  readonly session: string
  readonly target: string
  readonly outputChars: number
  readonly modelCallsAfter: number
  readonly status: "scored" | "skipped" | "error"
  readonly reason?: string
  // Для каждого фрагмента-кандидата: диапазон строк, размер, вероятность Jev, число нужных строк.
  readonly chunks?: readonly {
    readonly range: LineRange
    readonly chars: number
    readonly p: number
    readonly needed: number
    readonly neededStrict: number
  }[]
  readonly neededTotal?: number
  readonly evidence?: Readonly<Record<string, number>>
  readonly jevTokens?: number
  readonly jevMs?: number
}

export type FilterCaseInput = {
  readonly filter: FilterKind
  readonly session: string
  readonly event: ToolEvent
  readonly context: TaskContext
  readonly later: readonly ToolEvent[]
  readonly laterTexts: readonly string[]
  readonly modelCallsAfter: number
  readonly decide: Decide
  readonly settings: Settings["filter"]
}

function outputLines(filter: FilterKind, lines: readonly string[]): ReadonlyMap<number, string> {
  switch (filter) {
    case "read":
      return new Map(lines.map((line) => [Number.parseInt(line, 10), line.slice(line.indexOf(": ") + 2)] as const))
    case "output":
      return new Map(lines.map((line, i) => [i + 1, line] as const))
  }
}

export async function evaluateFilter(input: FilterCaseInput): Promise<FilterCase> {
  const target = input.filter === "read" ? String(input.event.input["filePath"] ?? "") : String(input.event.input["command"] ?? "").slice(0, 200)
  const base = { kind: "filter", filter: input.filter, session: input.session, target, outputChars: input.event.output.length, modelCallsAfter: input.modelCallsAfter } as const
  const plan = planFilter(input.filter, input.event.output, input.context, input.settings)
  if (plan === undefined) return { ...base, status: "skipped", reason: "unparsed_output" }
  if (!worthAsking(plan, input.event.output.length, input.settings)) return { ...base, status: "skipped", reason: "pinned_majority" }

  const relevance = await scoreRelevance({ decide: input.decide, context: input.context, source: target, chunks: plan.candidates, budget: input.settings })
  if (!relevance.ok) return { ...base, status: "error", reason: relevance.reason }

  const lines = outputLines(input.filter, plan.chunks.flatMap((chunk) => chunk.lines))
  const evidence = collectEvidence({ kind: input.filter, path: target.replaceAll("\\", "/"), lines, later: input.later, laterTexts: input.laterTexts })
  const strict = collectEvidence({ kind: input.filter, path: target.replaceAll("\\", "/"), lines, later: input.later, laterTexts: [] })
  const count = (needed: ReadonlySet<number>, [from, to]: LineRange): number => [...needed].filter((line) => line >= from && line <= to).length
  return {
    ...base,
    status: "scored",
    chunks: plan.candidates.map((chunk) => {
      const range = plan.range(chunk)
      return { range, chars: chunk.text.length, p: relevance.probabilities.get(chunk.index) ?? 1, needed: count(evidence.needed, range), neededStrict: count(strict.needed, range) }
    }),
    neededTotal: evidence.needed.size,
    evidence: evidence.reasons,
    jevTokens: relevance.inputTokens,
    jevMs: relevance.ms,
  }
}

export type SubagentCase = {
  readonly kind: "subagent"
  readonly session: string
  readonly tool: string
  readonly description: string
  readonly status: "scored" | "skipped" | "error"
  readonly reason?: string
  // Факт из истории: отчет непригоден (ошибка, пусто) или оркестратор его отверг.
  readonly actualBad: boolean
  readonly actualReason: string
  readonly scores?: Readonly<Record<string, number>>
  readonly jevTokens?: number
}

const HARD_FAIL = /Session error|Bad request from AI provider|internal error|\bTask (failed|error)\b|<task_error>/i
// Явный отказ оркестратора от результата; «сделаю сам» без признака сбоя не считается отказом.
const REJECTED =
  /(завершил[аси]{0,2}\s+(с\s+)?ошибк|без результат|пуст(ой|ым|ого)\s+(ответ|результат|отчет|отчёт)|оборва(лся|н)|не вернул[аи]?\s+(результат|итог|вывод)|не дал[аи]?\s+результат|результат(а)?\s+нет|перезапуска(ю|ем)\s+(задач|делегац|субагент)|повтор(ю|яю)\s+(задач|делегац)|(ошибк|сбо)[а-я]*[^.]{0,60}(сделаю|выполню|соберу)( нужное)? сам)/i

export function labelReport(report: string, nextTexts: readonly string[], relaunched: boolean): { readonly bad: boolean; readonly reason: string } {
  const body = report.replace(/^[\s\S]*?\n---\n/, "").trim()
  if (HARD_FAIL.test(report)) return { bad: true, reason: "hard_fail" }
  if (body.length < 80) return { bad: true, reason: "empty" }
  if (relaunched) return { bad: true, reason: "relaunched" }
  if (REJECTED.test((nextTexts[0] ?? "").slice(0, 1500))) return { bad: true, reason: "rejected_by_orchestrator" }
  return { bad: false, reason: "accepted" }
}

export type SubagentCaseInput = {
  readonly session: string
  readonly event: ToolEvent
  readonly nextTexts: readonly string[]
  readonly relaunched: boolean
  readonly decide: Decide
  readonly flagThreshold: number
}

export async function evaluateSubagent(input: SubagentCaseInput): Promise<SubagentCase> {
  const description = String(input.event.input["description"] ?? /^Description: (.+)$/m.exec(input.event.output)?.[1] ?? "")
  const label = labelReport(input.event.output, input.nextTexts, input.relaunched)
  const base = { kind: "subagent", session: input.session, tool: input.event.tool, description, actualBad: label.bad, actualReason: label.reason } as const
  const assignment = String(input.event.input["prompt"] ?? input.event.input["description"] ?? "")
  const result = await checkSubagent({ assignment, report: input.event.output, decide: input.decide, flagThreshold: input.flagThreshold })
  switch (result.kind) {
    case "skip":
      return { ...base, status: "skipped", reason: result.reason }
    case "error":
      return { ...base, status: "error", reason: result.reason }
    case "checked":
      return { ...base, status: "scored", scores: result.scores, jevTokens: result.jevInputTokens }
  }
}
