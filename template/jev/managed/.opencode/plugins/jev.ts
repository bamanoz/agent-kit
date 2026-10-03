// Слой решений Jev (agent-kit): фильтр релевантности вывода тулов и проверка отчетов субагентов.
// Режимы (scripts/jev): off — плагин ничего не делает; shadow — решения только журналируются;
// on — решения применяются. Любой сбой Jev или плагина оставляет вывод тула без изменений.
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { createDecide, type Decide } from "../jev/client.ts"
import { loadTaskContext } from "../jev/context.ts"
import { filterOutput, type FilterKind } from "../jev/filters.ts"
import { writeLog, type Feature, type LogEntry } from "../jev/log.ts"
import { readSkipReason } from "../jev/rules.ts"
import { loadSettings, resolveMode, type Mode, type Settings } from "../jev/settings.ts"
import { checkSubagent } from "../jev/subagent.ts"

type ToolOutput = { title: string; output: string; metadata: unknown }
type ToolCall = { readonly tool: string; readonly sessionID: string; readonly args: Readonly<Record<string, unknown>> }
type Run = { readonly call: ToolCall; readonly out: ToolOutput; readonly mode: Mode; readonly settings: Settings }

const text = (value: unknown): string => (typeof value === "string" ? value : "")

export const JevPlugin: Plugin = async ({ client, directory }: PluginInput) => {
  const readsBySession = new Map<string, Set<string>>()
  let decider: { readonly key: Settings["provider"]; readonly decide: Decide } | undefined
  const decideFor = (settings: Settings): Decide => {
    if (decider?.key !== settings.provider) decider = { key: settings.provider, decide: createDecide(settings.provider) }
    return decider.decide
  }
  const log = (mode: Mode, entry: Omit<LogEntry, "mode">): void => writeLog(directory, { mode, ...entry })

  async function filter(run: Run, kind: FilterKind): Promise<void> {
    const { call, out, mode, settings } = run
    const feature: Feature = kind === "read" ? "read_filter" : "output_filter"
    const minChars = kind === "read" ? settings.filter.readMinChars : settings.filter.outputMinChars
    if (out.output.length < minChars) return
    const target = kind === "read" ? text(call.args["filePath"]) : text(call.args["command"]).slice(0, 200)
    const base = { session: call.sessionID, feature, tool: call.tool, target, beforeChars: out.output.length }
    const context = await loadTaskContext(client, call.sessionID)
    if (context === undefined) return log(mode, { ...base, decision: "skipped", reason: "no_task_context" })
    const seen = readsBySession.get(call.sessionID) ?? new Set<string>()
    readsBySession.set(call.sessionID, seen)
    const skip = kind === "read" ? readSkipReason(call.args, context.task, seen, settings.filter) : undefined
    if (skip !== undefined) return log(mode, { ...base, decision: "skipped", reason: skip })
    const result = await filterOutput({ kind, source: target, output: out.output, context, decide: decideFor(settings), settings: settings.filter })
    switch (result.kind) {
      case "skip":
        return log(mode, { ...base, decision: "skipped", reason: result.reason })
      case "error":
        return log(mode, { ...base, decision: "error", reason: result.reason })
      case "filtered": {
        const { output, kind: _kind, ...stats } = result
        if (mode === "on") out.output = output
        return log(mode, { ...base, ...stats, decision: mode === "on" ? "applied" : "shadow", reason: "irrelevant_chunks", afterChars: output.length })
      }
    }
  }

  async function subagent(run: Run): Promise<void> {
    const { call, out, mode, settings } = run
    const base = { session: call.sessionID, feature: "subagent_check" as const, tool: call.tool, target: text(call.args["description"]) }
    const result = await checkSubagent({
      assignment: text(call.args["prompt"]) || text(call.args["description"]),
      report: out.output,
      decide: decideFor(settings),
      flagThreshold: settings.subagent.flagThreshold,
    })
    switch (result.kind) {
      case "skip":
        return
      case "error":
        return log(mode, { ...base, decision: "error", reason: result.reason })
      case "checked": {
        const { note, scores, jevMs, jevInputTokens } = result
        const stats = { scores, jevMs, jevInputTokens }
        if (note === undefined) return log(mode, { ...base, ...stats, decision: "skipped", reason: "report_ok" })
        if (mode === "on") out.output += note
        return log(mode, { ...base, ...stats, decision: mode === "on" ? "applied" : "shadow", reason: "report_flagged" })
      }
    }
  }

  return {
    "tool.execute.after": async (input, output) => {
      const mode = resolveMode(directory)
      // У MCP-тулов результат — объект content[], а не строка: такие вызовы не обрабатываются.
      if (mode === "off" || typeof output.output !== "string") return
      const settings = loadSettings(directory)
      const run: Run = { call: { tool: input.tool, sessionID: input.sessionID, args: input.args ?? {} }, out: output, mode, settings }
      try {
        if (input.tool === "read" && settings.features.readFilter) await filter(run, "read")
        else if (settings.filter.outputTools.includes(input.tool) && settings.features.outputFilter) await filter(run, "output")
        else if (settings.subagent.tools.includes(input.tool) && settings.features.subagentCheck) await subagent(run)
      } catch (error) {
        // no-excuse-ok: catch — граница плагина: сбой не должен ломать тул, вывод остается исходным.
        const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown"
        log(mode, { session: input.sessionID, feature: "plugin", tool: input.tool, decision: "error", reason })
      }
    },
  }
}
