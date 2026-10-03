// Разметка по факту: какие строки вывода понадобились агенту позже в той же сессии.
import type { LineRange } from "../filters.ts"
import { normalizePath } from "../rules.ts"
import type { ToolEvent } from "./history.ts"

// Строка считается нужной, если агент позже ее правил, дочитывал или упомянул ее уникальный идентификатор.
export type Evidence = {
  readonly needed: ReadonlySet<number>
  readonly reasons: Readonly<Record<string, number>>
}

const MIN_LINE = 12
const IDENT = /[A-Za-z_][A-Za-z0-9_]{5,}|(?:CHG|ADR|OQ|ARCH)-\d{3,4}/g

const normalize = (line: string): string => line.trim().replace(/\s+/g, " ")

function patchLines(patch: string, path: string): readonly string[] {
  // Строки контекста и удаляемые строки из блоков нужного файла в формате apply_patch.
  const lines: string[] = []
  let active = false
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      active = normalizePath(header[1]) === path
      continue
    }
    if (line.startsWith("*** ")) active = false
    else if (active && (line.startsWith("-") || line.startsWith(" "))) lines.push(line.slice(1))
  }
  return lines
}

export type EvidenceInput = {
  readonly kind: "read" | "output"
  readonly path: string
  // Строки вывода: для read — "N: текст", для output — текст; номера с 1.
  readonly lines: ReadonlyMap<number, string>
  readonly later: readonly ToolEvent[]
  readonly laterTexts: readonly string[]
}

export function collectEvidence(input: EvidenceInput): Evidence {
  const needed = new Set<number>()
  const reasons: Record<string, number> = {}
  const mark = (line: number, reason: string): void => {
    if (!needed.has(line)) reasons[reason] = (reasons[reason] ?? 0) + 1
    needed.add(line)
  }
  const index = new Map<string, number[]>()
  for (const [number, text] of input.lines) {
    const key = normalize(text)
    if (key.length < MIN_LINE) continue
    index.set(key, [...(index.get(key) ?? []), number])
  }
  const markText = (text: string, reason: string): void => {
    for (const line of text.split("\n")) for (const number of index.get(normalize(line)) ?? []) mark(number, reason)
  }

  for (const event of input.later) {
    const target = normalizePath(event.input["filePath"])
    const samePath = input.kind === "read" && target === input.path
    if (samePath && event.tool === "edit" && typeof event.input["oldString"] === "string") markText(event.input["oldString"], "edit")
    if (input.kind === "read" && event.tool === "apply_patch" && typeof event.input["patchText"] === "string")
      for (const line of patchLines(event.input["patchText"], input.path)) markText(line, "edit")
    if (samePath && event.tool === "read" && typeof event.input["offset"] === "number") {
      const from = event.input["offset"]
      const count = typeof event.input["limit"] === "number" ? event.input["limit"] : 2000
      for (const number of input.lines.keys()) if (number >= from && number < from + count) mark(number, "reread")
    }
  }

  // Идентификаторы, которые встречаются ровно в одной строке вывода и затем появились в рассуждениях агента.
  const owners = new Map<string, number | null>()
  for (const [number, text] of input.lines)
    for (const id of new Set(text.match(IDENT) ?? [])) owners.set(id, owners.has(id) && owners.get(id) !== number ? null : number)
  const later = input.laterTexts.join("\n")
  for (const [id, number] of owners) if (number !== null && later.includes(id)) mark(number, "mention")
  return { needed, reasons }
}

export const rangeHits = (ranges: readonly LineRange[], needed: ReadonlySet<number>): number =>
  [...needed].filter((line) => ranges.some(([from, to]) => line >= from && line <= to)).length
