// Проверка отчета субагента: пустой, ошибочный или неподтвержденный результат помечается для оркестратора.
import { noul, type Decide, type Question } from "./client.ts"

const REPORT_CHARS = 24000

// Ответы о запуске или статусе незавершенной фоновой задачи — не отчет, их не проверяем.
const NOT_A_REPORT = /Background (task|agent task|delegate) (launched|continued)|state: running|^# Task Status/m

const QUESTIONS = {
  incomplete: {
    type: "noul",
    instructions:
      "Отчет `report` пустой, оборван, сообщает об ошибке или не содержит запрошенного в `assignment` результата?",
  },
  unverified: {
    type: "noul",
    instructions:
      "Отчет `report` заявляет о выполнении правок или тестов, но не приводит подтверждений: вывода сборки или тестов, списка измененных файлов, коммитов?",
  },
  stub: {
    type: "noul",
    instructions: "Отчет `report` признает, что оставлены заглушки, TODO, пропущенные части или отложенная работа?",
  },
} as const satisfies Record<string, Question>

type Flag = keyof typeof QUESTIONS
const FLAGS = Object.keys(QUESTIONS) as readonly Flag[]

const NOTES: Readonly<Record<Flag, string>> = {
  incomplete: "результат пустой, оборван, с ошибкой или без запрошенных выводов",
  unverified: "заявленные правки или тесты не подтверждены выводом",
  stub: "оставлены заглушки или отложенная работа",
}

export type SubagentInput = {
  readonly assignment: string
  readonly report: string
  readonly decide: Decide
  readonly flagThreshold: number
}

export type SubagentResult =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string }
  | {
      readonly kind: "checked"
      readonly note: string | undefined
      readonly scores: Readonly<Record<Flag, number>>
      readonly jevMs: number
      readonly jevInputTokens: number
    }

export async function checkSubagent(input: SubagentInput): Promise<SubagentResult> {
  if (NOT_A_REPORT.test(input.report)) return { kind: "skip", reason: "not_a_report" }
  // У background_output задания в аргументах нет: берем описание из заголовка результата.
  const assignment = input.assignment || (/^Description: (.+)$/m.exec(input.report)?.[1] ?? "")
  const outcome = await input.decide({
    state: { assignment: assignment.slice(0, 4000), report: input.report.slice(-REPORT_CHARS) },
    questions: QUESTIONS,
  })
  if (!outcome.ok) return { kind: "error", reason: outcome.reason }
  const scores: Record<Flag, number> = { incomplete: 0, unverified: 0, stub: 0 }
  for (const flag of FLAGS) {
    const probability = noul(outcome, flag)
    if (probability === undefined) return { kind: "error", reason: "missing_answer" }
    scores[flag] = Math.round(probability * 100) / 100
  }
  const raised = FLAGS.filter((flag) => scores[flag] >= input.flagThreshold)
  const note =
    raised.length === 0
      ? undefined
      : `\n\n[Проверка Jev отчета субагента: ${raised.map((flag) => `${NOTES[flag]} (p=${scores[flag].toFixed(2)})`).join("; ")}. Не считай задачу выполненной, пока не проверишь результат по правилу «Subagent Reliability».]`
  return { kind: "checked", note, scores, jevMs: outcome.ms, jevInputTokens: outcome.inputTokens }
}
