// Правила, когда вывод read не фильтруется: общие для плагина и оценки по истории.
import type { Settings } from "./settings.ts"

export type ReadArgs = Readonly<Record<string, unknown>>

export const normalizePath = (value: unknown): string => (typeof value === "string" ? value.replaceAll("\\", "/") : "")

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

// seen — пути, уже прочитанные в сессии; функция добавляет в него текущий путь.
export function readSkipReason(args: ReadArgs, task: string, seen: Set<string>, settings: Settings["filter"]): string | undefined {
  const path = normalizePath(args["filePath"])
  if (args["offset"] !== undefined || args["limit"] !== undefined) return "explicit_range"
  if (settings.neverFilter.some((pattern) => new RegExp(pattern).test(path))) return "never_filter"
  // Повторное чтение означает, что файл нужен агенту: фильтр не применяется.
  if (seen.has(path)) return "repeat_read"
  seen.add(path)
  if (task.includes(baseName(path))) return "named_in_task"
  return undefined
}
