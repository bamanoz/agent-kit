import { existsSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { ResolvedTarget, ResolveError, RunnerPlugin, TargetResult } from 'focused-spec/runner'
import { runCommand, tail } from './process.ts'

const HELPER_PATH = fileURLToPath(new URL('./py_unittest_helper.py', import.meta.url))
const DOTTED_ID = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/
const LIST_MARKER = 'FOCUSED_SPEC_LIST '
const RESULT_MARKER = 'FOCUSED_SPEC_RESULT '

export interface PySelector {
  readonly dir: string
  readonly testId: string
}

type Outcome = 'success' | 'failure' | 'error' | 'skipped'

interface ListLine { readonly id: string; readonly ok: boolean; readonly message: string }
interface ResultLine { readonly id: string; readonly outcome: Outcome; readonly detail: string }

// Разбирает селектор «<каталог>::<dotted id>»; каталог обязан лежать внутри projectRoot.
export function parsePySelector(selector: string, projectRoot: string): PySelector | string {
  const separator = selector.indexOf('::')
  if (separator <= 0) return 'селектор должен иметь вид «<каталог>::<модуль.Класс.метод>»'
  const relDir = selector.slice(0, separator)
  const testId = selector.slice(separator + 2)
  if (!DOTTED_ID.test(testId)) return `недопустимый идентификатор теста unittest: «${testId}»`
  if (path.isAbsolute(relDir)) return 'каталог должен быть задан относительно корня проекта'
  const candidate = path.resolve(projectRoot, relDir)
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return `каталог не найден: «${relDir}»`
  const root = realpathSync(projectRoot)
  const dir = realpathSync(candidate)
  const relative = path.relative(root, dir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return `каталог «${relDir}» находится вне корня проекта`
  return { dir, testId }
}

function pythonExecutable(options: unknown): string {
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    const python = (options as Record<string, unknown>).python
    if (typeof python === 'string' && python.length > 0) return python
  }
  // В Windows интерпретатор обычно доступен как python, в Linux и macOS — как python3.
  return process.platform === 'win32' ? 'python' : 'python3'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Извлекает JSON-строки с заданным маркером; некорректный JSON — ошибка runner'а.
function markerPayloads(stdout: string, marker: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(marker)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice(marker.length))
    } catch {
      throw new Error(`Некорректная строка вспомогательного скрипта: ${tail(line, 500)}`)
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') throw new Error(`Некорректная строка вспомогательного скрипта: ${tail(line, 500)}`)
    payloads.push(parsed)
  }
  return payloads
}

function parseListLines(stdout: string): ListLine[] {
  return markerPayloads(stdout, LIST_MARKER).map(item => {
    if (typeof item.ok !== 'boolean') throw new Error('В строке FOCUSED_SPEC_LIST отсутствует поле ok')
    return { id: String(item.id), ok: item.ok, message: typeof item.message === 'string' ? item.message : '' }
  })
}

const OUTCOMES: readonly Outcome[] = ['success', 'failure', 'error', 'skipped']

export function parseResultLines(stdout: string): ResultLine[] {
  return markerPayloads(stdout, RESULT_MARKER).map(item => {
    const outcome = OUTCOMES.find(value => value === item.outcome)
    if (outcome === undefined) throw new Error(`Неизвестный исход теста: ${JSON.stringify(item.outcome)}`)
    return { id: String(item.id), outcome, detail: typeof item.detail === 'string' ? item.detail : '' }
  })
}

// Сводит строки результата одного теста (включая подтесты) в итог цели.
export function classifyPy(targetId: string, lines: readonly ResultLine[]): TargetResult {
  if (lines.length === 0) return { targetId, status: 'fail', diagnostic: 'тест не выполнен: результат не получен' }
  const failed = lines.filter(line => line.outcome === 'failure' || line.outcome === 'error')
  if (failed.length > 0) {
    return { targetId, status: 'fail', diagnostic: tail(failed.map(line => `[${line.outcome}] ${line.detail}`).join('\n'), 4000) }
  }
  if (lines.some(line => line.outcome === 'skipped')) {
    return { targetId, status: 'skip', diagnostic: tail(lines.map(line => line.detail).join('\n'), 1000) }
  }
  return { targetId, status: 'pass' }
}

function groupByDir<T>(items: readonly T[], dirOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = dirOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

async function helper(python: string, mode: 'list' | 'run', dir: string, ids: readonly string[], signal: AbortSignal) {
  const result = await runCommand({ command: python, args: ['-B', HELPER_PATH, mode, ...ids], cwd: dir, signal })
  const marker = mode === 'list' ? LIST_MARKER : RESULT_MARKER
  if (result.code !== 0 && !result.stdout.includes(marker)) {
    throw new Error(`Вспомогательный скрипт unittest завершился с кодом ${result.code} в ${dir}:\n${tail(result.stderr + '\n' + result.stdout)}`)
  }
  return result
}

export default {
  apiVersion: 1,

  async resolve(request) {
    const targets: ResolvedTarget[] = []
    const errors: ResolveError[] = []
    const parsed: { selector: string; spec: PySelector }[] = []
    for (const selector of request.selectors) {
      const spec = parsePySelector(selector, request.projectRoot)
      if (typeof spec === 'string') errors.push({ selector, message: spec })
      else parsed.push({ selector, spec })
    }
    const python = pythonExecutable(request.options)
    for (const [dir, items] of groupByDir(parsed, item => item.spec.dir)) {
      request.signal.throwIfAborted()
      const result = await helper(python, 'list', dir, items.map(item => item.spec.testId), request.signal)
      const lines = new Map(parseListLines(result.stdout).map(line => [line.id, line]))
      for (const { selector, spec } of items) {
        const line = lines.get(spec.testId)
        if (line === undefined) errors.push({ selector, message: 'вспомогательный скрипт не сообщил результат проверки' })
        else if (!line.ok) errors.push({ selector, message: line.message })
        else targets.push({ selector, targetId: selector, displayName: spec.testId, data: { dir: path.relative(request.projectRoot, dir) || '.' } })
      }
    }
    return { targets, errors }
  },

  async run(request) {
    const python = pythonExecutable(request.options)
    const parsed = request.targets.map(target => {
      const spec = parsePySelector(target.selector, request.projectRoot)
      if (typeof spec === 'string') throw new Error(`Селектор «${target.selector}» стал недействительным: ${spec}`)
      return { target, spec }
    })
    const results: TargetResult[] = []
    for (const [dir, items] of groupByDir(parsed, item => item.spec.dir)) {
      request.signal.throwIfAborted()
      const unique = [...new Set(items.map(item => item.spec.testId))]
      const result = await helper(python, 'run', dir, unique, request.signal)
      const lines = parseResultLines(result.stdout)
      for (const { target, spec } of items) {
        results.push(classifyPy(target.targetId, lines.filter(line => line.id === spec.testId)))
      }
    }
    return { results }
  },
} satisfies RunnerPlugin
