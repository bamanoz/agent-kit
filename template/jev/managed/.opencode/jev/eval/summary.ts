// Сводка оценки: ложные скрытия, экономия по порогам, точность проверки субагентов, вердикт.
import type { Settings } from "../settings.ts"
import { FLAGGING } from "../subagent.ts"
import type { FilterCase, SubagentCase } from "./cases.ts"

// Критерии включения режима on (обсуждены с пользователем).
export const CRITERIA = { falseHideMax: 0.02, savingMin: 0.2, subagentPrecisionMin: 0.7, subagentFalseFlagMax: 0.05 } as const
const CHARS_PER_TOKEN = 3
const JEV_PRICE_PER_M = 0.0525
const THRESHOLDS = [0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3] as const

type Scored = FilterCase & { readonly status: "scored"; readonly chunks: NonNullable<FilterCase["chunks"]> }
const isScored = (item: FilterCase): item is Scored => item.status === "scored" && item.chunks !== undefined

type Point = {
  readonly threshold: number
  readonly falseHide: number
  readonly falseHideStrict: number
  readonly casesHurt: number
  readonly saving: number
  readonly tokensSaved: number
  readonly applied: number
}

function sweep(cases: readonly Scored[], allChars: number, minSavingRatio: number, threshold: number): Point {
  let needed = 0
  let neededHidden = 0
  let strict = 0
  let strictHidden = 0
  let hiddenChars = 0
  let tokensSaved = 0
  let hurt = 0
  let applied = 0
  for (const item of cases) {
    const hidden = item.chunks.filter((chunk) => chunk.p < threshold)
    const chars = hidden.reduce((sum, chunk) => sum + chunk.chars, 0)
    const active = chars >= item.outputChars * minSavingRatio
    needed += item.neededTotal ?? 0
    strict += item.chunks.reduce((sum, chunk) => sum + chunk.neededStrict, 0)
    if (!active) continue
    applied += 1
    const lost = hidden.reduce((sum, chunk) => sum + chunk.needed, 0)
    neededHidden += lost
    strictHidden += hidden.reduce((sum, chunk) => sum + chunk.neededStrict, 0)
    if (lost > 0) hurt += 1
    hiddenChars += chars
    // Скрытый текст не передается модели в каждом следующем запросе до компактинга.
    tokensSaved += (chars / CHARS_PER_TOKEN) * Math.max(1, item.modelCallsAfter)
  }
  return {
    threshold,
    falseHide: needed === 0 ? 0 : neededHidden / needed,
    falseHideStrict: strict === 0 ? 0 : strictHidden / strict,
    casesHurt: cases.length === 0 ? 0 : hurt / cases.length,
    saving: allChars === 0 ? 0 : hiddenChars / allChars,
    tokensSaved,
    applied,
  }
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const int = (value: number): string => Math.round(value).toLocaleString("ru-RU")

function filterSection(name: string, all: readonly FilterCase[], settings: Settings): string[] {
  const scored = all.filter(isScored)
  const allChars = all.filter((item) => item.status !== "error").reduce((sum, item) => sum + item.outputChars, 0)
  const errors = all.filter((item) => item.status === "error").length
  const skipped = all.filter((item) => item.status === "skipped").length
  const withNeeded = scored.filter((item) => (item.neededTotal ?? 0) > 0).length
  const lines = [
    `## ${name}`,
    "",
    `Случаев: ${all.length} (оценено Jev ${scored.length}, пропущено правилами ${skipped}, ошибок ${errors}); с разметкой «нужно» по факту: ${withNeeded}.`,
    "",
    "| порог | ложные скрытия | только правки/дочитывания | случаев с потерей | экономия символов | ≈ токенов сэкономлено | применено |",
    "|---|---|---|---|---|---|---|",
  ]
  const points = THRESHOLDS.map((threshold) => sweep(scored, allChars, settings.filter.minSavingRatio, threshold))
  for (const point of points) {
    const mark = point.threshold === settings.filter.keepThreshold ? " ←" : ""
    lines.push(`| ${point.threshold}${mark} | ${pct(point.falseHide)} | ${pct(point.falseHideStrict)} | ${pct(point.casesHurt)} | ${pct(point.saving)} | ${int(point.tokensSaved)} | ${point.applied} |`)
  }
  const buckets = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.01]
  lines.push("", "Калибровка: доля фрагментов, которые агенту понадобились, по оценке Jev.", "", "| p Jev | фрагментов | нужны |", "|---|---|---|")
  const chunks = scored.flatMap((item) => item.chunks)
  for (let i = 0; i + 1 < buckets.length; i += 1) {
    const from = buckets[i] ?? 0
    const to = buckets[i + 1] ?? 1
    const inBucket = chunks.filter((chunk) => chunk.p >= from && chunk.p < to)
    if (inBucket.length === 0) continue
    lines.push(`| ${from}–${Math.min(to, 1)} | ${inBucket.length} | ${pct(inBucket.filter((chunk) => chunk.needed > 0).length / inBucket.length)} |`)
  }
  const current = points.find((point) => point.threshold === settings.filter.keepThreshold) ?? sweep(scored, allChars, settings.filter.minSavingRatio, settings.filter.keepThreshold)
  const best = points.filter((point) => point.falseHide <= CRITERIA.falseHideMax).sort((a, b) => b.saving - a.saving)[0]
  const pass = current.falseHide <= CRITERIA.falseHideMax && current.saving >= CRITERIA.savingMin
  lines.push(
    "",
    `**Вердикт при текущем пороге ${settings.filter.keepThreshold}: ${pass ? "можно включать on" : "оставить shadow/off"}** ` +
      `(ложные скрытия ${pct(current.falseHide)} при норме ≤ ${pct(CRITERIA.falseHideMax)}, экономия ${pct(current.saving)} при норме ≥ ${pct(CRITERIA.savingMin)}).`,
    best ? `Лучший порог в пределах нормы ложных скрытий: ${best.threshold} — экономия ${pct(best.saving)}.` : "Ни один порог не укладывается в норму ложных скрытий.",
    "",
  )
  return lines
}

function subagentSection(all: readonly SubagentCase[], settings: Settings): string[] {
  const scored = all.filter((item) => item.status === "scored" && item.scores !== undefined)
  const threshold = settings.subagent.flagThreshold
  const flaggedAt = (item: SubagentCase, at: number): boolean => FLAGGING.some((flag) => (item.scores?.[flag] ?? 0) >= at)
  const flagged = (item: SubagentCase): boolean => flaggedAt(item, threshold)
  const tp = scored.filter((item) => flagged(item) && item.actualBad).length
  const fp = scored.filter((item) => flagged(item) && !item.actualBad).length
  const fn = scored.filter((item) => !flagged(item) && item.actualBad).length
  const good = scored.filter((item) => !item.actualBad).length
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const falseFlag = good === 0 ? 0 : fp / good
  const reasons = new Map<string, number>()
  for (const item of scored.filter((entry) => entry.actualBad)) reasons.set(item.actualReason, (reasons.get(item.actualReason) ?? 0) + 1)
  const pass = precision >= CRITERIA.subagentPrecisionMin && falseFlag <= CRITERIA.subagentFalseFlagMax
  return [
    "## Проверка отчетов субагентов",
    "",
    `Отчетов: ${all.length} (оценено ${scored.length}, ошибок ${all.filter((item) => item.status === "error").length}); непригодных по факту: ${scored.length - good} (${[...reasons].map(([reason, count]) => `${reason} ${count}`).join(", ") || "нет"}).`,
    "",
    `При пороге ${threshold}: пометок ${tp + fp}, верных ${tp}, ложных ${fp}, пропущено непригодных ${fn}.`,
    `Точность ${pct(precision)} (норма ≥ ${pct(CRITERIA.subagentPrecisionMin)}), полнота ${pct(recall)}, ложные пометки на нормальных отчетах ${pct(falseFlag)} (норма ≤ ${pct(CRITERIA.subagentFalseFlagMax)}).`,
    "",
    "",
    "| порог | пометок | верных | точность | полнота | ложные на нормальных |",
    "|---|---|---|---|---|---|",
    ...[0.5, 0.7, 0.8, 0.85, 0.9, 0.95].map((at) => {
      const marks = scored.filter((item) => flaggedAt(item, at))
      const right = marks.filter((item) => item.actualBad).length
      const bad = scored.length - good
      return `| ${at}${at === threshold ? " ←" : ""} | ${marks.length} | ${right} | ${pct(marks.length === 0 ? 0 : right / marks.length)} | ${pct(bad === 0 ? 0 : right / bad)} | ${pct(good === 0 ? 0 : (marks.length - right) / good)} |`
    }),
    "",
    `**Вердикт: ${pass ? "можно включать on" : "оставить shadow/off"}.**`,
    "",
  ]
}

export function summarize(cases: readonly (FilterCase | SubagentCase)[], settings: Settings): string {
  const filters = cases.filter((item): item is FilterCase => item.kind === "filter")
  const subagents = cases.filter((item): item is SubagentCase => item.kind === "subagent")
  const jevTokens = cases.reduce((sum, item) => sum + (item.jevTokens ?? 0), 0)
  const errors = new Map<string, number>()
  for (const item of cases) if (item.status === "error") errors.set(item.reason ?? "?", (errors.get(item.reason ?? "?") ?? 0) + 1)
  return [
    "# Оценка слоя Jev по истории сессий",
    "",
    "Разметка «нужно» по факту: строку агент позже правил (edit/apply_patch), дочитывал (read с offset) " +
      "или упомянул ее уникальный идентификатор в рассуждениях. Столбец «только правки/дочитывания» — без упоминаний.",
    `Экономия токенов — оценка: ${CHARS_PER_TOKEN} символа на токен × число последующих запросов модели до компактинга.`,
    `Jev: ${int(jevTokens)} входных токенов ≈ $${((jevTokens / 1e6) * JEV_PRICE_PER_M).toFixed(3)}.` +
      (errors.size > 0 ? ` Ошибки Jev: ${[...errors].map(([reason, count]) => `${reason} ${count}`).join(", ")}.` : ""),
    "",
    ...filterSection("Фильтр read", filters.filter((item) => item.filter === "read"), settings),
    ...filterSection("Фильтр вывода bash", filters.filter((item) => item.filter === "output"), settings),
    ...subagentSection(subagents, settings),
  ].join("\n")
}
