// Журнал решений Jev в JSONL: основа отчета и сравнения режимов off/shadow/on.
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { LOG_DIR, type Mode } from "./settings.ts"

export type Feature = "read_filter" | "output_filter" | "subagent_check" | "plugin"

export type LogEntry = {
  readonly session: string
  readonly mode: Mode
  readonly feature: Feature
  readonly tool: string
  // applied — изменение применено; shadow — только рассчитано; skipped — изменение не требуется; error — сбой.
  readonly decision: "applied" | "shadow" | "skipped" | "error"
  readonly reason: string
  readonly target?: string
  readonly beforeChars?: number
  readonly afterChars?: number
  readonly chunks?: number
  readonly hidden?: number
  readonly hiddenRanges?: readonly (readonly [number, number])[]
  readonly scores?: Readonly<Record<string, number>>
  readonly jevMs?: number
  readonly jevInputTokens?: number
}

export function writeLog(root: string, entry: LogEntry): void {
  const now = new Date()
  const dir = join(root, LOG_DIR)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ ts: now.toISOString(), ...entry })}\n`)
}
