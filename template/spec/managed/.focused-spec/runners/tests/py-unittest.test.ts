import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResolvedTarget } from 'focused-spec/runner'
import runner from '../py-unittest.ts'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dir = '.focused-spec/runners/tests/fixtures/pyproj'
const sel = (id: string): string => `${dir}::tests.test_sample.${id}`

function context() {
  return { projectRoot, cwd: projectRoot, runnerId: 'py-unittest', options: {}, signal: new AbortController().signal }
}

async function resolveOne(selector: string) {
  return runner.resolve({ ...context(), selectors: [selector] })
}

async function resolveTargets(selectors: readonly string[]): Promise<readonly ResolvedTarget[]> {
  const response = await runner.resolve({ ...context(), selectors })
  assert.deepEqual(response.errors, [])
  return response.targets
}

describe('py-unittest resolve', () => {
  it('разрешает точный id в одну цель с исходным селектором', async () => {
    const response = await resolveOne(sel('SampleTests.test_pass'))
    assert.deepEqual(response.errors, [])
    assert.equal(response.targets.length, 1)
    assert.equal(response.targets[0]?.targetId, sel('SampleTests.test_pass'))
  })

  it('отклоняет отсутствующий тест', async () => {
    const response = await resolveOne(sel('SampleTests.test_missing'))
    assert.equal(response.targets.length, 0)
    assert.equal(response.errors.length, 1)
  })

  it('отклоняет селектор модуля и класса как выбирающий несколько тестов', async () => {
    const response = await runner.resolve({ ...context(), selectors: [`${dir}::tests.test_sample`, sel('SampleTests')] })
    assert.equal(response.targets.length, 0)
    assert.equal(response.errors.length, 2)
    for (const error of response.errors) assert.match(error.message, /несколько тестов/)
  })

  it('отклоняет каталог вне корня проекта', async () => {
    const response = await resolveOne('../x::tests.test_sample.SampleTests.test_pass')
    assert.equal(response.targets.length, 0)
    assert.match(response.errors[0]?.message ?? '', /не найден|вне корня/)
  })
})

describe('py-unittest run', () => {
  it('сопоставляет pass, fail и skip по каждому тесту', async () => {
    const targets = await resolveTargets([sel('SampleTests.test_pass'), sel('SampleTests.test_fail'), sel('SampleTests.test_skip')])
    const { results } = await runner.run({ ...context(), targets })
    const byId = new Map(results.map(result => [result.targetId, result]))
    assert.equal(byId.get(sel('SampleTests.test_pass'))?.status, 'pass')
    assert.equal(byId.get(sel('SampleTests.test_fail'))?.status, 'fail')
    assert.match(byId.get(sel('SampleTests.test_fail'))?.diagnostic ?? '', /намеренный отказ фикстуры/)
    assert.equal(byId.get(sel('SampleTests.test_skip'))?.status, 'skip')
  })

  it('выполняет только запрошенные цели', async () => {
    const targets = await resolveTargets([sel('SampleTests.test_pass')])
    const { results } = await runner.run({ ...context(), targets })
    assert.deepEqual(results, [{ targetId: sel('SampleTests.test_pass'), status: 'pass' }])
  })

  it('ошибка tearDownClass не дает pass успешному тесту класса', async () => {
    const targets = await resolveTargets([sel('BrokenTeardownTests.test_ok'), sel('SampleTests.test_pass')])
    const { results } = await runner.run({ ...context(), targets })
    const byId = new Map(results.map(result => [result.targetId, result]))
    assert.equal(byId.get(sel('BrokenTeardownTests.test_ok'))?.status, 'fail')
    assert.match(byId.get(sel('BrokenTeardownTests.test_ok'))?.diagnostic ?? '', /tearDownClass/)
    assert.equal(byId.get(sel('SampleTests.test_pass'))?.status, 'pass')
  })

  it('ошибка запуска интерпретатора не превращается в pass', async () => {
    const targets = await resolveTargets([sel('SampleTests.test_pass')])
    await assert.rejects(runner.run({ ...context(), options: { python: 'python3-absent-focused-spec' }, targets }), /Не удалось запустить/)
  })
})
