import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { TargetStatus } from 'focused-spec/runner'

const FQN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/
const LIST_HEADER = 'The following Tests are available:'
const DIAGNOSTIC_LIMIT = 4000

export interface DotnetSelector {
  readonly project: string
  readonly fqn: string
}

export interface TrxResult {
  readonly testName: string
  readonly outcome: string
  readonly message?: string
}

export interface Classification {
  readonly status: TargetStatus
  readonly diagnostic?: string
}

export type ListMatch =
  | { readonly kind: 'fact' }
  | { readonly kind: 'theory'; readonly cases: number }
  | { readonly kind: 'error'; readonly message: string }

// Разбирает селектор «<путь к .csproj>::<FQN>»; проект обязан лежать внутри projectRoot.
export function parseSelector(selector: string, projectRoot: string): DotnetSelector | string {
  const separator = selector.indexOf('::')
  if (separator <= 0) return 'селектор должен иметь вид «<путь к .csproj>::<Namespace.Класс.Метод>»'
  const relProject = selector.slice(0, separator)
  const fqn = selector.slice(separator + 2)
  if (!FQN.test(fqn)) return `недопустимое полное имя теста: «${fqn}»`
  if (!relProject.endsWith('.csproj')) return `ожидается путь к .csproj: «${relProject}»`
  if (path.isAbsolute(relProject)) return 'путь к проекту должен быть задан относительно корня проекта'
  const candidate = path.resolve(projectRoot, relProject)
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return `проект не найден: «${relProject}»`
  const relative = path.relative(realpathSync(projectRoot), realpathSync(candidate))
  if (relative.startsWith('..') || path.isAbsolute(relative)) return `проект «${relProject}» находится вне корня проекта`
  return { project: realpathSync(candidate), fqn }
}

// Возвращает имена тестов из вывода «dotnet test --list-tests» после заголовка.
export function parseListTests(output: string): string[] {
  const lines = output.split(/\r?\n/)
  const header = lines.findIndex(line => line.trim() === LIST_HEADER)
  if (header < 0) return []
  return lines.slice(header + 1).filter(line => line.startsWith('    ') && line.trim().length > 0).map(line => line.trim())
}

// Определяет, выбирает ли FQN ровно один Fact или набор случаев одного Theory.
export function matchListed(fqn: string, names: readonly string[]): ListMatch {
  const exact = names.filter(name => name === fqn).length
  const cases = names.filter(name => name.startsWith(`${fqn}(`)).length
  if (exact > 0 && cases > 0) return { kind: 'error', message: `имя «${fqn}» неоднозначно: есть и тест без параметров, и случаи Theory` }
  if (exact > 1) return { kind: 'error', message: `имя «${fqn}» встречается ${exact} раз` }
  if (exact === 1) return { kind: 'fact' }
  if (cases > 0) return { kind: 'theory', cases }
  return { kind: 'error', message: `тест не найден: «${fqn}»` }
}

// Строит фильтр VSTest; FQN уже проверены регулярным выражением и не требуют экранирования.
export function buildFilter(fqns: readonly string[]): string {
  if (fqns.length === 0) throw new Error('Пустой список тестов для фильтра')
  for (const fqn of fqns) if (!FQN.test(fqn)) throw new Error(`Недопустимое полное имя теста: «${fqn}»`)
  return [...new Set(fqns)].map(fqn => `FullyQualifiedName=${fqn}`).join('|')
}

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|quot|amp|lt|gt|apos);/g, (entity, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    const named: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" }
    return named[body] ?? entity
  })
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes)
  if (match === null) return undefined
  return decodeXml(match[1] ?? match[2] ?? '')
}

function element(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(body)
  return match === null ? undefined : decodeXml(match[1] ?? '')
}

// Извлекает результаты UnitTestResult из TRX (самозакрывающиеся и полные элементы).
export function parseTrx(xml: string): TrxResult[] {
  const results: TrxResult[] = []
  const pattern = /<UnitTestResult(\s[^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g
  for (const match of xml.matchAll(pattern)) {
    const attributes = match[1] ?? ''
    const testName = attribute(attributes, 'testName')
    const outcome = attribute(attributes, 'outcome')
    if (testName === undefined || outcome === undefined) throw new Error('В TRX найден UnitTestResult без testName или outcome')
    const body = match[3] ?? ''
    const parts = [element(body, 'Message'), element(body, 'StackTrace')].filter((part): part is string => part !== undefined && part.trim() !== '')
    results.push(parts.length > 0 ? { testName, outcome, message: parts.join('\n') } : { testName, outcome })
  }
  return results
}

function bounded(text: string): string {
  return text.length <= DIAGNOSTIC_LIMIT ? text : `${text.slice(0, DIAGNOSTIC_LIMIT)}…`
}

// Сводит результаты TRX выбранного теста в итог цели; cases — ожидаемое число случаев Theory.
export function classify(fqn: string, results: readonly TrxResult[], cases?: number): Classification {
  const selected = results.filter(result => result.testName === fqn || result.testName.startsWith(`${fqn}(`))
  if (selected.length === 0) return { status: 'fail', diagnostic: `тест не выполнен: «${fqn}» отсутствует в TRX` }
  const bad = selected.filter(result => result.outcome !== 'Passed' && result.outcome !== 'NotExecuted')
  if (bad.length > 0) {
    const text = bad.map(result => `${result.testName}: ${result.outcome}${result.message === undefined ? '' : `\n${result.message}`}`).join('\n\n')
    return { status: 'fail', diagnostic: bounded(text) }
  }
  if (selected.every(result => result.outcome === 'NotExecuted')) {
    return { status: 'skip', diagnostic: bounded(selected.map(result => result.message ?? result.testName).join('\n')) }
  }
  if (selected.some(result => result.outcome === 'NotExecuted')) {
    const skipped = selected.filter(result => result.outcome === 'NotExecuted').map(result => result.testName)
    return { status: 'fail', diagnostic: bounded(`часть случаев не выполнена: ${skipped.join(', ')}`) }
  }
  if (cases !== undefined && selected.length < cases) {
    return { status: 'fail', diagnostic: `выполнено ${selected.length} случаев Theory из ${cases} ожидаемых` }
  }
  return { status: 'pass' }
}

/**
 * Учитывает код выхода dotnet test. Ненулевой код без отказов в TRX (обрыв testhost, ошибка
 * сборки после записи отчета, сбой логгера) не может подтверждать прохождение: такие PASS
 * становятся FAIL с диагностикой.
 */
export function applyExitCode(verdict: Classification, exitCode: number, trx: readonly TrxResult[], output: string): Classification {
  if (exitCode === 0 || verdict.status !== 'pass') return verdict
  if (trx.some(result => result.outcome !== 'Passed' && result.outcome !== 'NotExecuted')) return verdict
  return { status: 'fail', diagnostic: bounded(`dotnet test завершился с кодом ${exitCode} без отказов тестов в TRX:\n${output}`) }
}
