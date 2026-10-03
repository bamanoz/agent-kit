// Тесты слоя Jev без сети: решения Jev подменяются функцией decide.
// Запуск: node --test .opencode/jev/jev.test.ts (Node 22.18+ или 24).
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseReadOutput, splitChunks, taskIdentifiers } from "./chunks.ts"
import type { Decide, DecisionRequest } from "./client.ts"
import { filterOutput } from "./filters.ts"
import { DEFAULTS, MODE_FILE, SETTINGS_FILE, loadSettings, parseSettings, resolveMode } from "./settings.ts"
import { checkSubagent } from "./subagent.ts"

const readOutput = (lines: readonly string[]): string =>
  ["<path>/x/File.cs</path>", "<type>file</type>", "<content>", ...lines.map((line, i) => `${i + 1}: ${line}`), "", "(End of file - total 1 lines)", "</content>"].join("\n")

// Jev отвечает «нужен» только для фрагментов, содержащих слово-маркер.
const fakeDecide =
  (marker: string): Decide =>
  async (request: DecisionRequest) => {
    const state = request.state as { readonly chunks: Readonly<Record<string, string>> }
    const answers = Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: state.chunks[id]?.includes(marker) ? 0.9 : 0.05 }]),
    )
    return { ok: true, answers, inputTokens: 100, ms: 5, cached: false }
  }

const failingDecide: Decide = async () => ({ ok: false, reason: "timeout", ms: 8000 })

const bigFile = (): string => {
  const lines = ["using System;"]
  for (let i = 0; i < 600; i += 1) lines.push(i >= 300 && i < 320 ? `// нужный блок matcher ${i}` : `// посторонний код монитора ${i} ${"x".repeat(40)}`)
  return readOutput(lines)
}

const context = { task: "Исправь поиск входящего сообщения по OprId", intent: "Читаю сопоставитель" }
const settings = DEFAULTS.filter

test("фильтр read скрывает нерелевантные фрагменты и сохраняет нумерацию строк", async () => {
  const output = bigFile()
  const result = await filterOutput({ kind: "read", source: "File.cs", output, context, decide: fakeDecide("matcher"), settings })
  assert.equal(result.kind, "filtered")
  if (result.kind !== "filtered") return
  assert.ok(result.output.length < output.length / 2)
  assert.match(result.output, /^\d+: \/\/ нужный блок matcher 300$/m)
  assert.match(result.output, /скрыты фильтром релевантности Jev .* read с offset=\d+ limit=\d+/)
  assert.ok(result.output.startsWith("<path>/x/File.cs</path>\n<type>file</type>\n<content>\n[Фильтр Jev скрыл "))
  assert.ok(result.output.endsWith("</content>"))
})

test("при сбое Jev фильтр возвращает ошибку, а не измененный вывод", async () => {
  const result = await filterOutput({ kind: "read", source: "File.cs", output: bigFile(), context, decide: failingDecide, settings })
  assert.deepEqual(result, { kind: "error", reason: "timeout" })
})

test("фрагмент с идентификатором из задачи не скрывается", async () => {
  const lines = Array.from({ length: 600 }, (_, i) => (i === 450 ? "var id = OprId;" : `// строка ${i} ${"y".repeat(40)}`))
  const result = await filterOutput({ kind: "read", source: "File.cs", output: readOutput(lines), context, decide: fakeDecide("никогда"), settings })
  assert.equal(result.kind, "filtered")
  if (result.kind === "filtered") assert.match(result.output, /^451: var id = OprId;$/m)
})

test("фильтр вывода команд сохраняет строки с ошибками даже при низкой оценке Jev", async () => {
  const lines = Array.from({ length: 800 }, (_, i) => (i === 400 ? "error CS1002: ; expected" : `Restoring package ${i} ${"z".repeat(30)}`))
  const result = await filterOutput({ kind: "output", source: "dotnet build", output: lines.join("\n"), context, decide: fakeDecide("никогда"), settings })
  assert.equal(result.kind, "filtered")
  if (result.kind === "filtered") assert.match(result.output, /error CS1002/)
})

test("если экономия мала, фильтр ничего не меняет", async () => {
  const result = await filterOutput({ kind: "read", source: "File.cs", output: bigFile(), context, decide: fakeDecide("//"), settings })
  assert.equal(result.kind, "skip")
})

test("проверка субагента пропускает сообщения о запуске фоновой задачи", async () => {
  const result = await checkSubagent({ assignment: "x", report: "Background task launched.\nTask ID: bg_1", decide: failingDecide, flagThreshold: 0.6 })
  assert.equal(result.kind, "skip")
})

test("проверка субагента добавляет пометку при высокой вероятности неполного отчета", async () => {
  const decide: Decide = async () => ({
    ok: true,
    answers: { incomplete: { type: "noul", noul: 0.9 }, unverified: { type: "noul", noul: 0.1 }, stub: { type: "noul", noul: 0.1 } },
    inputTokens: 50,
    ms: 3,
    cached: false,
  })
  const result = await checkSubagent({ assignment: "Найди обработчик", report: "Ошибка: модель не ответила", decide, flagThreshold: 0.6 })
  assert.equal(result.kind, "checked")
  if (result.kind === "checked") assert.match(result.note ?? "", /Subagent Reliability/)
})

test("режим: переменная окружения важнее файла, неизвестное значение означает off", () => {
  assert.equal(resolveMode(mkdtempSync(join(tmpdir(), "jev-mode-"))), "off")
  const root = mkdtempSync(join(tmpdir(), "jev-mode-"))
  mkdirSync(join(root, ".opencode"))
  writeFileSync(join(root, MODE_FILE), "on\n")
  assert.equal(resolveMode(root), "on")
  process.env["JEV_MODE"] = "shadow"
  assert.equal(resolveMode(root), "shadow")
  process.env["JEV_MODE"] = "turbo"
  assert.equal(resolveMode(root), "off")
  delete process.env["JEV_MODE"]
})

test("настройки проекта дополняют значения комплекта, неверные поля игнорируются", () => {
  const parsed = parseSettings({ filter: { keepThreshold: 0.3, neverFilter: ["/kb/"], readMinChars: "много" }, features: { outputFilter: false } })
  assert.equal(parsed.filter.keepThreshold, 0.3)
  assert.equal(parsed.filter.readMinChars, DEFAULTS.filter.readMinChars)
  assert.equal(parsed.features.outputFilter, false)
  assert.ok(parsed.filter.neverFilter.includes("/kb/") && parsed.filter.neverFilter.length === DEFAULTS.filter.neverFilter.length + 1)
  const root = mkdtempSync(join(tmpdir(), "jev-settings-"))
  mkdirSync(join(root, ".opencode"))
  writeFileSync(join(root, SETTINGS_FILE), "{ это не JSON")
  assert.deepEqual(loadSettings(root), DEFAULTS)
})

test("разбиение: идентификаторы задачи и разбор вывода read", () => {
  const ids = taskIdentifiers("CHG-0207 и cbdc.013, класс InboundMatcher", DEFAULTS.filter.pinPatterns)
  assert.deepEqual([...ids].sort(), ["cbdc.013", "chg-0207", "inboundmatcher"])
  assert.deepEqual(parseReadOutput(readOutput(["a", "b"]))?.lines, ["1: a", "2: b"])
  assert.equal(splitChunks(Array.from({ length: 250 }, (_, i) => `${i}: x`), settings).length, 3)
})
