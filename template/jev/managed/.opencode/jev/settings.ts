// Настройки слоя решений Jev: значения по умолчанию комплекта и проектный .opencode/jev.json.
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const MODES = ["off", "shadow", "on"] as const
export type Mode = (typeof MODES)[number]

export const MODE_FILE = join(".opencode", "jev.mode")
export const SETTINGS_FILE = join(".opencode", "jev.json")
export const LOG_DIR = join(".opencode", "jev-log")

export type Settings = {
  readonly provider: {
    readonly endpoint: string
    readonly model: string
    readonly apiKeyEnv: string
    // Имя провайдера в ~/.local/share/opencode/auth.json, откуда берется ключ, если переменной нет.
    readonly opencodeAuth: string
    readonly timeoutMs: number
  }
  readonly features: {
    readonly readFilter: boolean
    readonly outputFilter: boolean
    readonly subagentCheck: boolean
  }
  readonly filter: {
    readonly readMinChars: number
    readonly outputMinChars: number
    readonly keepThreshold: number
    readonly minSavingRatio: number
    readonly chunkMaxLines: number
    readonly chunkMaxChars: number
    readonly stateCharBudget: number
    readonly maxQuestionsPerRequest: number
    readonly outputTools: readonly string[]
    readonly neverFilter: readonly string[]
    readonly pinPatterns: readonly string[]
  }
  readonly subagent: {
    readonly tools: readonly string[]
    readonly flagThreshold: number
  }
}

export const DEFAULTS: Settings = {
  provider: {
    endpoint: "https://apiclo.com/v1/decisions",
    model: "jev-latest",
    apiKeyEnv: "APICLO_API_KEY",
    opencodeAuth: "apiclo",
    timeoutMs: 8000,
  },
  features: { readFilter: true, outputFilter: true, subagentCheck: true },
  filter: {
    readMinChars: 12000,
    outputMinChars: 16000,
    // Сдвиг в сторону сохранения: на русском тексте оценки Jev сжаты в диапазоне 0,1–0,2.
    keepThreshold: 0.15,
    minSavingRatio: 0.3,
    chunkMaxLines: 120,
    chunkMaxChars: 5000,
    // ~1,6 символа русского текста на токен; лимит провайдера — 32K токенов на state.
    stateCharBudget: 30000,
    maxQuestionsPerRequest: 24,
    outputTools: ["bash"],
    neverFilter: [
      "(^|/)(AGENTS|README)\\.md$",
      "(^|/)SKILL\\.md$",
      "(^|/)opencode\\.jsonc?$",
      "/\\.opencode/",
      "/\\.omo/(plans|drafts|rules)/",
      "/project-memory/session-protocol\\.md$",
    ],
    pinPatterns: ["(?:CHG|ADR|OQ|ARCH)-\\d{3,4}"],
  },
  subagent: { tools: ["task", "background_output"], flagThreshold: 0.6 },
}

type Json = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const section = (raw: Json, key: string): Json => {
  const value = raw[key]
  return isRecord(value) ? value : {}
}
const num = (raw: Json, key: string, fallback: number): number => {
  const value = raw[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
const str = (raw: Json, key: string, fallback: string): string => {
  const value = raw[key]
  return typeof value === "string" && value !== "" ? value : fallback
}
const bool = (raw: Json, key: string, fallback: boolean): boolean => {
  const value = raw[key]
  return typeof value === "boolean" ? value : fallback
}
const list = (raw: Json, key: string, fallback: readonly string[]): readonly string[] => {
  const value = raw[key]
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback
}

// Неизвестные или неверно типизированные поля игнорируются: действуют значения комплекта.
export function parseSettings(raw: unknown): Settings {
  const root = isRecord(raw) ? raw : {}
  const p = section(root, "provider")
  const f = section(root, "features")
  const x = section(root, "filter")
  const s = section(root, "subagent")
  const d = DEFAULTS
  return {
    provider: {
      endpoint: str(p, "endpoint", d.provider.endpoint),
      model: str(p, "model", d.provider.model),
      apiKeyEnv: str(p, "apiKeyEnv", d.provider.apiKeyEnv),
      opencodeAuth: str(p, "opencodeAuth", d.provider.opencodeAuth),
      timeoutMs: num(p, "timeoutMs", d.provider.timeoutMs),
    },
    features: {
      readFilter: bool(f, "readFilter", d.features.readFilter),
      outputFilter: bool(f, "outputFilter", d.features.outputFilter),
      subagentCheck: bool(f, "subagentCheck", d.features.subagentCheck),
    },
    filter: {
      readMinChars: num(x, "readMinChars", d.filter.readMinChars),
      outputMinChars: num(x, "outputMinChars", d.filter.outputMinChars),
      keepThreshold: num(x, "keepThreshold", d.filter.keepThreshold),
      minSavingRatio: num(x, "minSavingRatio", d.filter.minSavingRatio),
      chunkMaxLines: num(x, "chunkMaxLines", d.filter.chunkMaxLines),
      chunkMaxChars: num(x, "chunkMaxChars", d.filter.chunkMaxChars),
      stateCharBudget: num(x, "stateCharBudget", d.filter.stateCharBudget),
      maxQuestionsPerRequest: num(x, "maxQuestionsPerRequest", d.filter.maxQuestionsPerRequest),
      outputTools: list(x, "outputTools", d.filter.outputTools),
      neverFilter: [...d.filter.neverFilter, ...list(x, "neverFilter", [])],
      pinPatterns: [...d.filter.pinPatterns, ...list(x, "pinPatterns", [])],
    },
    subagent: {
      tools: list(s, "tools", d.subagent.tools),
      flagThreshold: num(s, "flagThreshold", d.subagent.flagThreshold),
    },
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (error instanceof Error) return undefined
    throw error
  }
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

let settingsCache: { readonly path: string; readonly mtime: number; readonly value: Settings } | undefined

export function loadSettings(root: string): Settings {
  const path = join(root, SETTINGS_FILE)
  let mtime = 0
  try {
    mtime = statSync(path).mtimeMs
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  if (settingsCache?.path === path && settingsCache.mtime === mtime) return settingsCache.value
  const value = parseSettings(parseJson(readText(path)))
  settingsCache = { path, mtime, value }
  return value
}

const isMode = (value: string): value is Mode => (MODES as readonly string[]).includes(value)

// Порядок: переменная JEV_MODE (A/B-прогоны) → файл .opencode/jev.mode → off.
export function resolveMode(root: string): Mode {
  const fromEnv = process.env["JEV_MODE"]?.trim()
  if (fromEnv !== undefined && fromEnv !== "") return isMode(fromEnv) ? fromEnv : "off"
  const fromFile = readText(join(root, MODE_FILE))?.trim() ?? "off"
  return isMode(fromFile) ? fromFile : "off"
}

export function loadApiKey(provider: Settings["provider"]): string | undefined {
  const fromEnv = process.env[provider.apiKeyEnv]?.trim()
  if (fromEnv) return fromEnv
  const dataHome = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
  const auth = parseJson(readText(join(dataHome, "opencode", "auth.json")))
  if (!isRecord(auth)) return undefined
  const entry = auth[provider.opencodeAuth]
  if (!isRecord(entry)) return undefined
  const key = entry["key"]
  return typeof key === "string" && key !== "" ? key : undefined
}
