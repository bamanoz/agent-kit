// Формулировка задачи для Jev: последний запрос пользователя и пояснение агента перед вызовом тула.
import type { PluginInput } from "@opencode-ai/plugin"

type Client = PluginInput["client"]

const TASK_CHARS = 2500
const INTENT_CHARS = 800
const HISTORY_LIMIT = 80

export type TaskContext = {
  readonly task: string
  readonly intent: string
}

type PartLike = { readonly type: string; readonly text?: string; readonly synthetic?: boolean }

const textOf = (parts: readonly PartLike[]): string =>
  parts
    .flatMap((part) => (part.type === "text" && part.text !== undefined && part.synthetic !== true ? [part.text] : []))
    .join("\n")
    .trim()

// Служебные напоминания оркестратора не являются постановкой задачи.
const isReminder = (text: string): boolean => /^(\[SYSTEM|<system-reminder>|\[Agent Usage|\[BACKGROUND)/.test(text)

export async function loadTaskContext(client: Client, sessionID: string): Promise<TaskContext | undefined> {
  const response = await client.session.messages({ path: { id: sessionID }, query: { limit: HISTORY_LIMIT } })
  const messages = response.data
  if (messages === undefined) return undefined
  let intent = ""
  for (const message of [...messages].reverse()) {
    const text = textOf(message.parts)
    if (text === "") continue
    if (message.info.role === "assistant") {
      if (intent === "") intent = text
      continue
    }
    if (isReminder(text)) continue
    return { task: text.slice(0, TASK_CHARS), intent: intent.slice(-INTENT_CHARS) }
  }
  return undefined
}
