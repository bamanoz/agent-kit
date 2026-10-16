import { spawn } from 'node:child_process'

// Предел объема каждого из потоков stdout/stderr дочернего процесса.
export const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly signal: AbortSignal
}

// Запускает процесс без shell с ограничением объема вывода.
export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    signal: spec.signal,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>()
  const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
  const sizes = { stdout: 0, stderr: 0 }
  let overflow: 'stdout' | 'stderr' | undefined
  const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    if (overflow !== undefined) return
    sizes[stream] += chunk.length
    if (sizes[stream] > OUTPUT_LIMIT_BYTES) {
      overflow = stream
      child.kill('SIGKILL')
      return
    }
    chunks[stream].push(chunk)
  }
  child.stdout.on('data', collect('stdout'))
  child.stderr.on('data', collect('stderr'))
  child.once('error', error => {
    reject(new Error(`Не удалось запустить «${spec.command}» в ${spec.cwd}: ${error.message}`, { cause: error }))
  })
  child.once('close', (code, signalName) => {
    if (overflow !== undefined) {
      reject(new Error(`Вывод ${overflow} команды «${spec.command}» превысил ${OUTPUT_LIMIT_BYTES} байт; процесс остановлен`))
      return
    }
    if (spec.signal.aborted) {
      reject(new Error(`Команда «${spec.command}» прервана`))
      return
    }
    resolve({
      code: code ?? (signalName === null ? 1 : 128),
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8'),
    })
  })
  return promise
}

// Возвращает ограниченный хвост текста для диагностики.
export function tail(text: string, limit = 4000): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}
