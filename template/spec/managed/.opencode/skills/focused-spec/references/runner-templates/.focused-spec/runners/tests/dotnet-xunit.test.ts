import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyExitCode, buildFilter, classify, matchListed, parseListTests, parseSelector, parseTrx } from '../dotnet-xunit-lib.ts'

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureTrx = '.focused-spec/runners/tests/fixtures/sample.trx'
const realProject = '.focused-spec/runners/tests/fixtures/dotnet/SampleProjectTests.csproj'

describe('parseListTests', () => {
  it('возвращает только имена после заголовка, игнорируя вывод сборки', () => {
    const names = parseListTests(fixture('list-tests.txt'))
    assert.equal(names.length, 6)
    assert.equal(names[0], 'SampleProjectTests.AddressingCatalogTests.LocalCatalog_CoversEveryFixtureRowAndContourType')
    assert.ok(names.every(name => !name.includes('->')))
  })

  it('возвращает пустой список без заголовка', () => {
    assert.deepEqual(parseListTests('  SampleProject -> x.dll\n    Not.A.Test\n'), [])
  })
})

describe('matchListed', () => {
  const names = parseListTests(fixture('list-tests.txt'))

  it('распознает Fact', () => {
    assert.deepEqual(matchListed('SampleProjectTests.AddressingCatalogTests.LocalCatalog_CoversEveryFixtureRowAndContourType', names), { kind: 'fact' })
  })

  it('распознает Theory и считает случаи, не путая метод с общим префиксом', () => {
    assert.deepEqual(matchListed('SampleProjectTests.AbsFunctionTests.ClassifyClient_WritesClientKind', names), { kind: 'theory', cases: 2 })
  })

  it('отклоняет отсутствующий и неоднозначный тест', () => {
    assert.equal(matchListed('SampleProjectTests.Missing.Method', names).kind, 'error')
    assert.equal(matchListed('SampleProjectTests.Ambiguous.Method', names).kind, 'error')
  })
})

describe('parseTrx', () => {
  const results = parseTrx(fixture('sample.trx'))

  it('читает самозакрывающиеся и полные элементы', () => {
    assert.equal(results.length, 7)
    assert.deepEqual(results[0], { testName: 'SampleProjectTests.Facts.Passing', outcome: 'Passed' })
    assert.equal(results[2]?.outcome, 'NotExecuted')
  })

  it('декодирует сущности XML в сообщении и имени', () => {
    assert.match(results[1]?.message ?? '', /Assert\.Equal\(\) Failure: "a" & <b> 'c' ЖЖ/)
    assert.match(results[1]?.message ?? '', /Facts\.cs:line 10/)
    assert.equal(results[3]?.testName, 'SampleProjectTests.Theories.Calc(a: 1, b: "x")')
  })
})

describe('classify', () => {
  const results = parseTrx(fixture('sample.trx'))

  it('Fact прошел', () => {
    assert.deepEqual(classify('SampleProjectTests.Facts.Passing', results), { status: 'pass' })
  })

  it('Fact упал с сообщением', () => {
    const verdict = classify('SampleProjectTests.Facts.Failing', results)
    assert.equal(verdict.status, 'fail')
    assert.match(verdict.diagnostic ?? '', /Assert\.Equal/)
  })

  it('все случаи NotExecuted дают skip', () => {
    assert.equal(classify('SampleProjectTests.Facts.Skipped', results).status, 'skip')
  })

  it('Theory: все случаи прошли', () => {
    assert.deepEqual(classify('SampleProjectTests.Theories.Calc', results, 2), { status: 'pass' })
  })

  it('Theory: упавший случай дает fail', () => {
    const verdict = classify('SampleProjectTests.Theories.Mixed', results, 2)
    assert.equal(verdict.status, 'fail')
    assert.match(verdict.diagnostic ?? '', /случай 2 упал/)
  })

  it('Theory: случаев меньше ожидаемого дает fail', () => {
    assert.equal(classify('SampleProjectTests.Theories.Calc', results, 3).status, 'fail')
  })

  it('отсутствующий в TRX тест дает fail, а не pass соседнего', () => {
    const verdict = classify('SampleProjectTests.Facts.Pass', results)
    assert.equal(verdict.status, 'fail')
    assert.match(verdict.diagnostic ?? '', /не выполнен/)
  })
})

describe('buildFilter', () => {
  it('объединяет уникальные FQN через |', () => {
    assert.equal(buildFilter(['A.B', 'C.D', 'A.B']), 'FullyQualifiedName=A.B|FullyQualifiedName=C.D')
  })

  it('отклоняет недопустимое имя', () => {
    assert.throws(() => buildFilter(['A.B|X']))
    assert.throws(() => buildFilter([]))
  })
})

describe('parseSelector', () => {
  it('отклоняет недопустимый FQN', () => {
    assert.equal(typeof parseSelector('a.csproj::Bad Name', projectRoot), 'string')
    assert.equal(typeof parseSelector('a.csproj::NoDots', projectRoot), 'string')
    assert.equal(typeof parseSelector('a.csproj::A.B(x: 1)', projectRoot), 'string')
  })

  it('отклоняет выход за корень, абсолютный путь и отсутствующий проект', () => {
    assert.match(String(parseSelector('../outside/X.csproj::A.B', projectRoot)), /не найден|вне корня/)
    assert.equal(typeof parseSelector('/etc/X.csproj::A.B', projectRoot), 'string')
    assert.match(String(parseSelector('missing/X.csproj::A.B', projectRoot)), /не найден/)
    assert.match(String(parseSelector(`${fixtureTrx}::A.B`, projectRoot)), /\.csproj/)
  })

  it('принимает существующий проект внутри корня', () => {
    const spec = parseSelector(`${realProject}::SampleProjectTests.X.Y`, projectRoot)
    assert.equal(typeof spec, 'object')
  })
})

describe('applyExitCode', () => {
  const passed = [{ testName: 'A.B.C', outcome: 'Passed' }]
  it('ненулевой код без отказов в TRX превращает pass в fail', () => {
    const verdict = applyExitCode({ status: 'pass' }, 1, passed, 'testhost aborted')
    assert.equal(verdict.status, 'fail')
    assert.match(verdict.diagnostic ?? '', /кодом 1/)
  })
  it('нулевой код сохраняет pass', () => {
    assert.deepEqual(applyExitCode({ status: 'pass' }, 0, passed, ''), { status: 'pass' })
  })
  it('ненулевой код из-за отказа другого теста не трогает pass выбранного', () => {
    const mixed = [...passed, { testName: 'A.B.D', outcome: 'Failed' }]
    assert.deepEqual(applyExitCode({ status: 'pass' }, 1, mixed, ''), { status: 'pass' })
  })
})
