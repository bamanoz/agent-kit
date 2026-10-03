// Чтение истории сессий OpenCode (SQLite, только чтение) и сбор случаев для оценки Jev.
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { taskFromMessages, type MessageLike, type PartLike, type TaskContext } from "../context.ts"

export type ToolEvent = {
  readonly order: number
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly output: string
}

export type TimelineItem =
  | { readonly kind: "tool"; readonly event: ToolEvent }
  | { readonly kind: "text"; readonly order: number; readonly role: string; readonly text: string }

export type Session = {
  readonly id: string
  readonly title: string
  readonly timeline: readonly TimelineItem[]
  // Сообщения до каждого события: для восстановления задачи на момент вызова.
  readonly messagesBefore: (order: number) => readonly MessageLike[]
  // Сколько запросов к модели сделано после события: столько раз скрытый текст не пришлось бы передавать.
  readonly modelCallsAfter: (order: number) => number
  // Входные токены сессии, включая чтение кэша.
  readonly contextTokens: number
}

type Json = Readonly<Record<string, unknown>>
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const parse = (raw: unknown): Json => {
  if (typeof raw !== "string") return {}
  const value: unknown = JSON.parse(raw)
  return isRecord(value) ? value : {}
}

export function defaultDbPath(): string {
  const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}

export type HistoryQuery = {
  readonly dbPath: string
  readonly directory: string
  readonly sinceDays: number
  // Исключить последние N дней: для проверки порогов на данных, не использованных при подборе.
  readonly skipDays: number
  readonly maxSessions: number
}

export function openHistory(query: HistoryQuery): { readonly sessions: () => Iterable<Session>; readonly close: () => void } {
  const db = new DatabaseSync(query.dbPath, { readOnly: true })
  const since = Date.now() - query.sinceDays * 86_400_000
  const until = Date.now() - query.skipDays * 86_400_000
  // Сессии проекта, включая его worktree и дочерние сессии субагентов.
  const ids = db
    .prepare("select id, title from session where (directory = ? or directory like ?) and time_created >= ? and time_created < ? order by time_created desc limit ?")
    .all(query.directory, `${query.directory}/%`, since, until, query.maxSessions)
  const messages = db.prepare("select id, data from message where session_id = ? order by time_created, id")
  const parts = db.prepare("select message_id, data from part where session_id = ? order by message_id, id")

  function* sessions(): Iterable<Session> {
    for (const row of ids) {
      const id = String(row["id"])
      const byMessage = new Map<string, Json[]>()
      for (const part of parts.all(id)) {
        const list = byMessage.get(String(part["message_id"])) ?? []
        list.push(parse(part["data"]))
        byMessage.set(String(part["message_id"]), list)
      }
      const timeline: TimelineItem[] = []
      const history: { readonly order: number; readonly message: MessageLike }[] = []
      const calls: number[] = []
      const compactions: number[] = []
      let contextTokens = 0
      let order = 0
      for (const message of messages.all(id)) {
        const info = parse(message["data"])
        const role = typeof info["role"] === "string" ? info["role"] : "unknown"
        const messageParts = byMessage.get(String(message["id"])) ?? []
        const textParts: PartLike[] = []
        const firstOrder = order + 1
        for (const part of messageParts) {
          order += 1
          if (part["type"] === "compaction") compactions.push(order)
          if (part["type"] === "text" && typeof part["text"] === "string") {
            textParts.push({ type: "text", text: part["text"], synthetic: part["synthetic"] === true })
            if (part["synthetic"] !== true) timeline.push({ kind: "text", order, role, text: part["text"] })
          }
          const state = isRecord(part["state"]) ? part["state"] : {}
          if (part["type"] === "tool" && state["status"] === "completed" && typeof state["output"] === "string") {
            timeline.push({
              kind: "tool",
              event: { order, tool: String(part["tool"]), input: isRecord(state["input"]) ? state["input"] : {}, output: state["output"] },
            })
          }
        }
        history.push({ order, message: { role, parts: textParts } })
        if (role === "assistant") {
          calls.push(firstOrder)
          const tokens = isRecord(info["tokens"]) ? info["tokens"] : {}
          const cache = isRecord(tokens["cache"]) ? tokens["cache"] : {}
          contextTokens += (Number(tokens["input"]) || 0) + (Number(cache["read"]) || 0)
        }
      }
      yield {
        id,
        title: String(row["title"]),
        timeline,
        messagesBefore: (at) => history.filter((item) => item.order < at).map((item) => item.message),
        // До ближайшего компактинга: после него история пересобирается.
        modelCallsAfter: (at) => {
          const until = compactions.find((item) => item > at) ?? Number.POSITIVE_INFINITY
          return calls.filter((item) => item > at && item < until).length
        },
        contextTokens,
      }
    }
  }
  return { sessions, close: () => db.close() }
}

export const taskAt = (session: Session, order: number): TaskContext | undefined => taskFromMessages(session.messagesBefore(order))

export const toolsAfter = (session: Session, order: number, limit: number): readonly ToolEvent[] =>
  session.timeline
    .flatMap((item) => (item.kind === "tool" && item.event.order > order ? [item.event] : []))
    .slice(0, limit)

export const textsAfter = (session: Session, order: number, limit: number): readonly string[] =>
  session.timeline
    .flatMap((item) => (item.kind === "text" && item.order > order && item.role === "assistant" ? [item.text] : []))
    .slice(0, limit)
