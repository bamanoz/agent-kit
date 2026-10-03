// Прогон оценки Jev по истории сессий OpenCode проекта.
// Запуск: scripts/jev eval [--days N] [--limit N] [--sessions N] [--out каталог] [--resume]
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { createDecide } from "../client.ts"
import { planFilter, worthAsking } from "../filters.ts"
import { readSkipReason } from "../rules.ts"
import { loadSettings } from "../settings.ts"
import { evaluateFilter, evaluateSubagent, labelReport, type FilterCase, type SubagentCase } from "./cases.ts"
import { defaultDbPath, openHistory, taskAt, textsAfter, toolsAfter, type Session, type ToolEvent } from "./history.ts"
import { summarize } from "./summary.ts"

const LATER_TOOLS = 60
const LATER_TEXTS = 12
const CONCURRENCY = 2

type Job = () => Promise<FilterCase | SubagentCase>
type Queued = { readonly id: string; readonly kind: "read" | "output" | "subagent"; readonly job: Job }

const { values } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    db: { type: "string", default: defaultDbPath() },
    days: { type: "string", default: "45" },
    "skip-days": { type: "string", default: "0" },
    sessions: { type: "string", default: "400" },
    limit: { type: "string", default: "300" },
    out: { type: "string" },
    resume: { type: "boolean", default: false },
    "summary-only": { type: "boolean", default: false },
    relabel: { type: "boolean", default: false },
  },
})

const root = resolve(values.root)
const outDir = resolve(values.out ?? join(root, ".opencode", "jev-eval"))
const casesFile = join(outDir, "cases.jsonl")
mkdirSync(outDir, { recursive: true })

const settings = loadSettings(root)
// В оценке предохранитель не нужен, а временные ошибки провайдера повторяются с тем же ключом идемпотентности.
const decide = createDecide({ ...settings.provider, timeoutMs: 30000 }, { breaker: { failuresToOpen: Number.POSITIVE_INFINITY, openMs: 0 }, retries: 4 })
const limit = Number(values.limit)

const caseId = (session: string, order: number): string => createHash("sha1").update(`${session}:${order}`).digest("hex").slice(0, 16)

function relaunched(session: Session, event: ToolEvent): boolean {
  const description = event.input["description"]
  if (typeof description !== "string" || description === "") return false
  return toolsAfter(session, event.order, 8).some(
    (later) => ["task", "call_omo_agent", "delegate_task"].includes(later.tool) && later.input["description"] === description,
  )
}

const isReport = (event: ToolEvent): boolean =>
  !/Background (task|agent task|delegate) (launched|continued)|state: running|^# Task Status/m.test(event.output)

// Отбор случаев: квоты по видам, равномерно по сессиям (не больше квоты/10 на сессию).
function collect(): readonly Queued[] {
  const quota = { read: Math.ceil(limit * 0.5), output: Math.ceil(limit * 0.25), subagent: Math.ceil(limit * 0.25) }
  const perSession = { read: Math.max(2, Math.ceil(quota.read / 10)), output: Math.max(2, Math.ceil(quota.output / 10)), subagent: Math.max(2, Math.ceil(quota.subagent / 10)) }
  const picked: Queued[] = []
  const taken = { read: 0, output: 0, subagent: 0 }
  const history = openHistory({ dbPath: values.db, directory: root.replace(/\/\.worktrees\/[^/]+$/, ""), sinceDays: Number(values.days), skipDays: Number(values["skip-days"]), maxSessions: Number(values.sessions) })
  for (const session of history.sessions()) {
    const local = { read: 0, output: 0, subagent: 0 }
    const seen = new Set<string>()
    for (const item of session.timeline) {
      if (item.kind !== "tool") continue
      const event = item.event
      const id = caseId(session.id, event.order)
      const kind =
        event.tool === "read" && settings.features.readFilter && event.output.length >= settings.filter.readMinChars
          ? "read"
          : settings.filter.outputTools.includes(event.tool) && settings.features.outputFilter && event.output.length >= settings.filter.outputMinChars
            ? "output"
            : settings.subagent.tools.includes(event.tool) && settings.features.subagentCheck && isReport(event)
              ? "subagent"
              : undefined
      if (event.tool === "read" && kind !== "read") seen.add(String(event.input["filePath"] ?? "").replaceAll("\\", "/"))
      if (kind === undefined || taken[kind] >= quota[kind] || local[kind] >= perSession[kind]) continue
      const context = taskAt(session, event.order)
      if (context === undefined) continue
      if (kind === "read" && readSkipReason(event.input, context.task, seen, settings.filter) !== undefined) continue
      // Пропуск правилами бесплатен и квоту не расходует: так видна реальная доля пропусков.
      if (kind !== "subagent") {
        const plan = planFilter(kind, event.output, context, settings.filter)
        const reason = plan === undefined ? "unparsed_output" : worthAsking(plan, event.output.length, settings.filter) ? undefined : "pinned_majority"
        if (reason !== undefined) {
          const target = kind === "read" ? String(event.input["filePath"] ?? "") : String(event.input["command"] ?? "").slice(0, 200)
          const skipped: FilterCase = { kind: "filter", filter: kind, session: session.id, target, outputChars: event.output.length, modelCallsAfter: session.modelCallsAfter(event.order), status: "skipped", reason }
          picked.push({ id, kind, job: async () => skipped })
          continue
        }
      }
      const later = toolsAfter(session, event.order, LATER_TOOLS)
      const laterTexts = textsAfter(session, event.order, LATER_TEXTS)
      const job: Job =
        kind === "subagent"
          ? () => evaluateSubagent({ session: session.id, event, nextTexts: laterTexts.slice(0, 2), relaunched: relaunched(session, event), decide, flagThreshold: settings.subagent.flagThreshold })
          : () => evaluateFilter({ filter: kind, session: session.id, event, context, later, laterTexts, modelCallsAfter: session.modelCallsAfter(event.order), decide, settings: settings.filter })
      picked.push({ id, kind, job })
      taken[kind] += 1
      local[kind] += 1
    }
    if (taken.read >= quota.read && taken.output >= quota.output && taken.subagent >= quota.subagent) break
  }
  history.close()
  return picked
}

// Пересчет меток «отчет непригоден» по истории без повторных вызовов Jev (после правки правил разметки).
function relabel(cases: readonly (FilterCase | SubagentCase)[]): readonly (FilterCase | SubagentCase)[] {
  const labels = new Map<string, ReturnType<typeof labelReport>>()
  const history = openHistory({ dbPath: values.db, directory: root.replace(/\/\.worktrees\/[^/]+$/, ""), sinceDays: Number(values.days), skipDays: Number(values["skip-days"]), maxSessions: Number(values.sessions) })
  for (const session of history.sessions())
    for (const item of session.timeline)
      if (item.kind === "tool" && settings.subagent.tools.includes(item.event.tool))
        labels.set(caseId(session.id, item.event.order), labelReport(item.event.output, textsAfter(session, item.event.order, 2), relaunched(session, item.event)))
  history.close()
  return cases.map((item) => {
    const label = item.kind === "subagent" ? labels.get(String((item as SubagentCase & { readonly id?: string }).id)) : undefined
    return label === undefined ? item : { ...item, actualBad: label.bad, actualReason: label.reason }
  })
}

async function main(): Promise<void> {
  if (!values["summary-only"] && !values.relabel) {
    const done = new Set<string>()
    if (values.resume && existsSync(casesFile)) {
      for (const line of readFileSync(casesFile, "utf8").split("\n").filter(Boolean)) done.add(String(JSON.parse(line).id))
    } else {
      writeFileSync(casesFile, "")
    }
    const queue = collect().filter((item) => !done.has(item.id))
    console.log(`случаев к оценке: ${queue.length} (уже оценено: ${done.size})`)
    let next = 0
    let finished = 0
    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        const item = queue[next]
        next += 1
        if (item === undefined) continue
        const result = await item.job()
        appendFileSync(casesFile, `${JSON.stringify({ id: item.id, ...result })}\n`)
        finished += 1
        if (finished % 20 === 0) console.log(`  оценено ${finished}/${queue.length}`)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }
  const loaded = readFileSync(casesFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FilterCase | SubagentCase)
  const cases = values.relabel ? relabel(loaded) : loaded
  if (values.relabel) writeFileSync(casesFile, cases.map((item) => JSON.stringify(item)).join("\n") + "\n")
  const report = summarize(cases, settings)
  writeFileSync(join(outDir, "report.md"), report)
  console.log(report)
  console.log(`\nслучаи: ${casesFile}\nотчет: ${join(outDir, "report.md")}`)
}

await main()
