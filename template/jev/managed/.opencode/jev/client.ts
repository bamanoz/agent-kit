// Клиент API решений Jev: таймаут, предохранитель, кэш, разбор ответа без внешних зависимостей.
import { createHash } from "node:crypto"
import { loadApiKey, type Settings } from "./settings.ts"

export type Question =
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] }

export type DecisionRequest = {
  readonly state: unknown
  readonly questions: Readonly<Record<string, Question>>
}

export type Answer =
  | { readonly type: "noul"; readonly noul: number }
  | { readonly type: "choice"; readonly choice: string; readonly confidence: number }
  | { readonly type: "score"; readonly score: number; readonly confidence: number }

export type DecisionOutcome =
  | {
      readonly ok: true
      readonly answers: Readonly<Record<string, Answer>>
      readonly inputTokens: number
      readonly ms: number
      readonly cached: boolean
    }
  | { readonly ok: false; readonly reason: string; readonly ms: number }

export type Decide = (request: DecisionRequest) => Promise<DecisionOutcome>

type Json = Readonly<Record<string, unknown>>
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

function parseAnswer(raw: unknown): Answer | undefined {
  if (!isRecord(raw)) return undefined
  const { type, noul, choice, score, confidence } = raw
  switch (type) {
    case "noul":
      return isNumber(noul) ? { type, noul } : undefined
    case "choice":
      return typeof choice === "string" && isNumber(confidence) ? { type, choice, confidence } : undefined
    case "score":
      return isNumber(score) && isNumber(confidence) ? { type, score, confidence } : undefined
    default:
      return undefined
  }
}

function parseResponse(raw: unknown): { readonly answers: Record<string, Answer>; readonly inputTokens: number } | undefined {
  if (!isRecord(raw) || !isRecord(raw["answers"]) || !isRecord(raw["usage"])) return undefined
  const inputTokens = raw["usage"]["input_tokens"]
  if (!isNumber(inputTokens)) return undefined
  const answers: Record<string, Answer> = {}
  for (const [id, value] of Object.entries(raw["answers"])) {
    const answer = parseAnswer(value)
    if (answer === undefined) return undefined
    answers[id] = answer
  }
  return { answers, inputTokens }
}

// Предохранитель: после серии сбоев Jev временно не вызывается, агент работает как без него.
const BREAKER = { failuresToOpen: 3, openMs: 120000 } as const
const CACHE_LIMIT = 500

export function createDecide(provider: Settings["provider"]): Decide {
  let consecutiveFailures = 0
  let openUntil = 0
  const cache = new Map<string, DecisionOutcome & { readonly ok: true }>()

  const fail = (reason: string, started: number): DecisionOutcome => {
    consecutiveFailures += 1
    if (consecutiveFailures >= BREAKER.failuresToOpen) openUntil = Date.now() + BREAKER.openMs
    return { ok: false, reason, ms: Date.now() - started }
  }

  return async (request) => {
    const started = Date.now()
    if (started < openUntil) return { ok: false, reason: "breaker_open", ms: 0 }
    const key = loadApiKey(provider)
    if (key === undefined) return { ok: false, reason: "no_api_key", ms: 0 }

    const body = JSON.stringify({ model: provider.model, state: request.state, questions: request.questions })
    const digest = createHash("sha256").update(body).digest("hex")
    const hit = cache.get(digest)
    if (hit) return { ...hit, ms: 0, cached: true }

    let response: Response
    try {
      // Повторов нет: после таймаута исход неизвестен. Ключ идемпотентности детерминирован,
      // поэтому ручной повтор того же запроса вернет сохраненный провайдером ответ.
      response = await fetch(provider.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `jev-${digest.slice(0, 48)}`,
        },
        body,
        signal: AbortSignal.timeout(provider.timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error) return fail(error.name === "TimeoutError" ? "timeout" : `network:${error.name}`, started)
      throw error
    }
    if (!response.ok) {
      const code = /"code"\s*:\s*"([a-z_]+)"/.exec(await response.text())?.[1]
      return fail(`http_${response.status}${code ? `:${code}` : ""}`, started)
    }
    let json: unknown
    try {
      json = await response.json()
    } catch (error) {
      if (error instanceof SyntaxError) return fail("bad_json", started)
      throw error
    }
    const parsed = parseResponse(json)
    if (parsed === undefined) return fail("bad_response", started)

    consecutiveFailures = 0
    const outcome = { ok: true, ...parsed, ms: Date.now() - started, cached: false } as const
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(digest, outcome)
    return outcome
  }
}

export function noul(outcome: DecisionOutcome, id: string): number | undefined {
  if (!outcome.ok) return undefined
  const answer = outcome.answers[id]
  return answer?.type === "noul" ? answer.noul : undefined
}
