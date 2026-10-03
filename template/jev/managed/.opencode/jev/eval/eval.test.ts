// Тесты оценки по истории без сети и без базы OpenCode.
import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULTS } from "../settings.ts"
import { labelReport, type FilterCase, type SubagentCase } from "./cases.ts"
import { collectEvidence } from "./evidence.ts"
import { summarize } from "./summary.ts"

const lines = new Map([
  [10, "public Task<Match?> FindByOprId(string oprId, CancellationToken ct)"],
  [11, "    return _store.FindAsync(oprId, ct);"],
  [50, "// постороннее описание журнала монитора"],
  [90, "var veryUniqueIdentifier = Compute();"],
])

test("разметка: правка, дочитывание и упоминание отмечают нужные строки", () => {
  const evidence = collectEvidence({
    kind: "read",
    path: "/repo/File.cs",
    lines,
    later: [
      { order: 2, tool: "edit", input: { filePath: "/repo/File.cs", oldString: "    return _store.FindAsync(oprId, ct);" }, output: "" },
      { order: 3, tool: "read", input: { filePath: "/repo/File.cs", offset: 48, limit: 5 }, output: "" },
      { order: 4, tool: "edit", input: { filePath: "/repo/Other.cs", oldString: "public Task<Match?> FindByOprId(string oprId, CancellationToken ct)" }, output: "" },
    ],
    laterTexts: ["Нашел veryUniqueIdentifier в файле"],
  })
  assert.deepEqual([...evidence.needed].sort((a, b) => a - b), [11, 50, 90])
  assert.deepEqual(evidence.reasons, { edit: 1, reread: 1, mention: 1 })
})

test("разметка: apply_patch учитывает только блоки того же файла", () => {
  const patch = "*** Begin Patch\n*** Update File: /repo/File.cs\n@@\n public Task<Match?> FindByOprId(string oprId, CancellationToken ct)\n-    return _store.FindAsync(oprId, ct);\n+    return null;\n*** End Patch"
  const evidence = collectEvidence({ kind: "read", path: "/repo/File.cs", lines, later: [{ order: 2, tool: "apply_patch", input: { patchText: patch }, output: "" }], laterTexts: [] })
  assert.deepEqual([...evidence.needed].sort((a, b) => a - b), [10, 11])
})

test("метка отчета: ошибка провайдера, пустой ответ, отказ оркестратора и принятый отчет", () => {
  const head = "Task completed in 1m.\n\n---\n\n"
  assert.equal(labelReport(`${head}**Bad request from AI provider**`, [], false).reason, "hard_fail")
  assert.equal(labelReport(`${head}ок`, [], false).reason, "empty")
  assert.equal(labelReport(`${head}${"Результат анализа. ".repeat(10)}`, ["Задача завершилась ошибкой без результата; соберу нужное сам."], false).reason, "rejected_by_orchestrator")
  assert.equal(labelReport(`${head}${"Результат анализа. ".repeat(10)}`, ["Проверю коммит субагента."], false).bad, false)
})

test("сводка: ложное скрытие считается по нужным строкам в скрытых фрагментах", () => {
  const filter: FilterCase = {
    kind: "filter",
    filter: "read",
    session: "s",
    target: "/repo/File.cs",
    outputChars: 10000,
    modelCallsAfter: 5,
    status: "scored",
    chunks: [
      { range: [1, 100], chars: 4000, p: 0.05, needed: 0, neededStrict: 0 },
      { range: [101, 200], chars: 4000, p: 0.1, needed: 2, neededStrict: 1 },
      { range: [201, 300], chars: 2000, p: 0.9, needed: 3, neededStrict: 3 },
    ],
    neededTotal: 5,
  }
  const subagent: SubagentCase = { kind: "subagent", session: "s", tool: "task", description: "d", status: "scored", actualBad: true, actualReason: "empty", scores: { incomplete: 0.9 } }
  const report = summarize([filter, subagent], DEFAULTS)
  // Порог 0.08: скрыт только первый фрагмент — потерь нет, экономия 40%.
  assert.match(report, /\| 0\.08 \| 0\.0% \| 0\.0% \| 0\.0% \| 40\.0% \|/)
  // Порог 0.15: скрыты первые два — потеряны 2 из 5 нужных строк.
  assert.match(report, /\| 0\.15 ← \| 40\.0% \| 25\.0% \| 100\.0% \| 80\.0% \|/)
  assert.match(report, /Точность 100\.0%/)
})
