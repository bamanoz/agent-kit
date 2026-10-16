import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ResolvedTarget, ResolveError, RunnerPlugin, TargetResult } from 'focused-spec/runner'
import { applyExitCode, buildFilter, classify, matchListed, parseListTests, parseSelector, parseTrx } from './dotnet-xunit-lib.ts'
import type { DotnetSelector } from './dotnet-xunit-lib.ts'
import { runCommand, tail } from './process.ts'

function noRestore(options: unknown): boolean {
  return typeof options === 'object' && options !== null && !Array.isArray(options)
    && (options as Record<string, unknown>).noRestore === true
}

function groupByProject<T extends { readonly spec: DotnetSelector }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(item.spec.project, [...(groups.get(item.spec.project) ?? []), item])
  return groups
}

function theoryCases(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  return record.theory === true && typeof record.cases === 'number' ? record.cases : undefined
}

export default {
  apiVersion: 1,

  async resolve(request) {
    const targets: ResolvedTarget[] = []
    const errors: ResolveError[] = []
    const parsed: { selector: string; spec: DotnetSelector }[] = []
    for (const selector of request.selectors) {
      const spec = parseSelector(selector, request.projectRoot)
      if (typeof spec === 'string') errors.push({ selector, message: spec })
      else parsed.push({ selector, spec })
    }
    const extra = noRestore(request.options) ? ['--no-restore'] : []
    for (const [project, items] of groupByProject(parsed)) {
      request.signal.throwIfAborted()
      const result = await runCommand({
        command: 'dotnet',
        args: ['test', project, '--list-tests', '--nologo', ...extra],
        cwd: request.projectRoot,
        signal: request.signal,
      })
      if (result.code !== 0) {
        throw new Error(`«dotnet test --list-tests» для ${project} завершился с кодом ${result.code}:\n${tail(result.stderr + '\n' + result.stdout)}`)
      }
      const names = parseListTests(result.stdout)
      for (const { selector, spec } of items) {
        const match = matchListed(spec.fqn, names)
        const source = { path: path.relative(request.projectRoot, project) }
        switch (match.kind) {
          case 'fact':
            targets.push({ selector, targetId: selector, displayName: spec.fqn, source })
            break
          case 'theory':
            targets.push({ selector, targetId: selector, displayName: `${spec.fqn} (Theory, случаев: ${match.cases})`, source, data: { theory: true, cases: match.cases } })
            break
          case 'error':
            errors.push({ selector, message: match.message })
            break
          default:
            match satisfies never
        }
      }
    }
    return { targets, errors }
  },

  async run(request) {
    const parsed = request.targets.map(target => {
      const spec = parseSelector(target.selector, request.projectRoot)
      if (typeof spec === 'string') throw new Error(`Селектор «${target.selector}» стал недействительным: ${spec}`)
      return { target, spec }
    })
    const extra = noRestore(request.options) ? ['--no-restore'] : []
    const results: TargetResult[] = []
    for (const [project, items] of groupByProject(parsed)) {
      request.signal.throwIfAborted()
      const resultsDir = await mkdtemp(path.join(os.tmpdir(), 'focused-spec-xunit-'))
      try {
        const result = await runCommand({
          command: 'dotnet',
          args: [
            'test', project, '--nologo', ...extra,
            '--filter', buildFilter(items.map(item => item.spec.fqn)),
            '--logger', 'trx;LogFileName=r.trx',
            '--results-directory', resultsDir,
          ],
          cwd: request.projectRoot,
          signal: request.signal,
        })
        let xml: string
        try {
          xml = await readFile(path.join(resultsDir, 'r.trx'), 'utf8')
        } catch (error) {
          throw new Error(`TRX-отчет не получен для ${project} (код выхода ${result.code}):\n${tail(result.stderr + '\n' + result.stdout)}`, { cause: error })
        }
        const trx = parseTrx(xml)
        for (const { target, spec } of items) {
          const verdict = classify(spec.fqn, trx, theoryCases(target.data))
          results.push({ targetId: target.targetId, ...applyExitCode(verdict, result.code, trx, tail(result.stderr + '\n' + result.stdout)) })
        }
      } finally {
        await rm(resultsDir, { recursive: true, force: true })
      }
    }
    return { results }
  },
} satisfies RunnerPlugin
