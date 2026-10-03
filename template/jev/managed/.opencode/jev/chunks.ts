// Разбиение вывода тулов на фрагменты и сборка сокращенного вывода.
import type { Settings } from "./settings.ts"

export type Chunk = {
  readonly index: number
  readonly lines: readonly string[]
  readonly text: string
}

// Вывод read: заголовок <path>/<type>/<content>, строки "N: текст", хвост с подсказкой о продолжении.
export type ReadOutput = {
  readonly head: string
  readonly lines: readonly string[]
  readonly tail: string
}

type Limits = Pick<Settings["filter"], "chunkMaxLines" | "chunkMaxChars">

const HEADING = /^\d+: #{1,4} /

export function splitChunks(lines: readonly string[], limits: Limits): readonly Chunk[] {
  const chunks: Chunk[] = []
  let current: string[] = []
  let chars = 0
  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({ index: chunks.length, lines: current, text: current.join("\n") })
    current = []
    chars = 0
  }
  for (const line of lines) {
    const full = current.length >= limits.chunkMaxLines || chars + line.length > limits.chunkMaxChars
    const atHeading = HEADING.test(line) && current.length >= 40
    if (full || atHeading) flush()
    current.push(line)
    chars += line.length + 1
  }
  flush()
  return chunks
}

export function parseReadOutput(output: string): ReadOutput | undefined {
  const open = output.indexOf("<content>\n")
  const close = output.lastIndexOf("\n</content>")
  if (open < 0 || close < open) return undefined
  const body = output.slice(open + "<content>\n".length, close)
  const hint = body.lastIndexOf("\n\n(")
  const content = hint >= 0 ? body.slice(0, hint) : body
  const lines = content.split("\n")
  if (!lines.every((line) => /^\d+: /.test(line))) return undefined
  return {
    head: output.slice(0, open + "<content>\n".length),
    lines,
    tail: (hint >= 0 ? body.slice(hint) : "") + output.slice(close),
  }
}

const lineNumber = (line: string | undefined): number => Number.parseInt(line ?? "0", 10)

export function readMarker(chunk: Chunk, probability: number): string {
  const from = lineNumber(chunk.lines[0])
  const to = lineNumber(chunk.lines[chunk.lines.length - 1])
  return `[строки ${from}–${to} скрыты фильтром релевантности Jev (p=${probability.toFixed(2)}); если нужны — read с offset=${from} limit=${to - from + 1}]`
}

export function outputMarker(chunk: Chunk, probability: number): string {
  return `[${chunk.lines.length} строк вывода скрыто фильтром релевантности Jev (p=${probability.toFixed(2)}); если нужны — повтори команду с фильтром grep/sed]`
}

// Вместо скрытого фрагмента — пометка с вероятностью и способом вернуть текст.
export function assemble(
  chunks: readonly Chunk[],
  hidden: ReadonlyMap<number, number>,
  marker: (chunk: Chunk, probability: number) => string,
): string {
  return chunks
    .map((chunk) => {
      const probability = hidden.get(chunk.index)
      return probability === undefined ? chunk.text : marker(chunk, probability)
    })
    .join("\n")
}

// Идентификаторы из задачи (camelCase/PascalCase, имена файлов, коды с цифрами и проектные шаблоны):
// фрагмент, где они встречаются, сохраняется без вопроса к Jev.
const IDENTIFIER = /[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*|[A-Za-z]{2,}[.-]?\d+[A-Za-z0-9]*|[A-Za-z_]{3,}\.[A-Za-z]{2,4}\b/g

export function taskIdentifiers(task: string, pinPatterns: readonly string[]): readonly string[] {
  const found = [...(task.match(IDENTIFIER) ?? [])]
  for (const pattern of pinPatterns) found.push(...(task.match(new RegExp(pattern, "g")) ?? []))
  return [...new Set(found.map((id) => id.toLowerCase()))]
}

export function mentionsAny(text: string, identifiers: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return identifiers.some((id) => lower.includes(id))
}

type Budget = Pick<Settings["filter"], "stateCharBudget" | "maxQuestionsPerRequest">

// Пакеты фрагментов, укладывающиеся в бюджет state одного запроса Jev.
export function batches(chunks: readonly Chunk[], fixedChars: number, budget: Budget): readonly (readonly Chunk[])[] {
  const result: Chunk[][] = []
  let current: Chunk[] = []
  let chars = fixedChars
  for (const chunk of chunks) {
    const overflow = chars + chunk.text.length > budget.stateCharBudget
    if (current.length > 0 && (overflow || current.length >= budget.maxQuestionsPerRequest)) {
      result.push(current)
      current = []
      chars = fixedChars
    }
    current.push(chunk)
    chars += chunk.text.length
  }
  if (current.length > 0) result.push(current)
  return result
}
