import { spawn } from "node:child_process"

import { sanitizedProcessEnvironment } from "./cli-discovery"
import type { ChildProcessWithoutNullStreams } from "node:child_process"

export type RpcId = number | string

export type RpcMessage = {
  id?: RpcId
  method?: string
  result?: unknown
  error?: { code?: number; message?: string }
  params?: unknown
}

type JsonLineProcessOptions = {
  requestTimeoutMs?: number
  gracefulStopMs?: number
  maxLineBytes?: number
}

const DEFAULT_MAX_LINE_BYTES = 1_000_000
const MAX_INVALID_LINES = 20

function terminatePosixProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
) {
  if (typeof child.pid !== "number") return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

function terminateWindowsProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean
) {
  if (typeof child.pid !== "number") return
  const arguments_ = ["/pid", String(child.pid), "/t"]
  if (force) arguments_.push("/f")
  const taskkill = spawn("taskkill.exe", arguments_, {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  })
  taskkill.unref()
}

export function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
) {
  if (process.platform === "win32") {
    terminateWindowsProcessTree(child, signal === "SIGKILL")
    return
  }
  terminatePosixProcessTree(child, signal)
}

export class JsonLineProcess {
  #child: ChildProcessWithoutNullStreams | null = null
  #nextId = 1
  #pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  #notifications = new Set<(message: RpcMessage) => void>()
  #requests = new Set<(message: RpcMessage & { id: RpcId }) => void>()
  #stderr = ""
  #stdoutBuffer = Buffer.alloc(0)
  #invalidLineCount = 0
  readonly #requestTimeoutMs: number
  readonly #gracefulStopMs: number
  readonly #maxLineBytes: number

  constructor(
    private readonly executablePath: string,
    private readonly arguments_: Array<string>,
    private readonly cwd: string,
    options: JsonLineProcessOptions = {}
  ) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.#gracefulStopMs = options.gracefulStopMs ?? 2_000
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  }

  start() {
    if (this.#child) return
    const child = spawn(this.executablePath, this.arguments_, {
      cwd: this.cwd,
      detached: process.platform !== "win32",
      env: sanitizedProcessEnvironment(this.executablePath),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.#child = child
    child.stdout.on("data", (chunk: Buffer) => this.#receiveChunk(chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-8_000)
    })
    child.once("error", (error) => this.#failAll(error))
    child.once("exit", (code, signal) => {
      const detail = this.#stderr
        ? "The local runtime reported an error."
        : `The local runtime exited (${code ?? signal ?? "unknown"}).`
      this.#failAll(new Error(detail))
      this.#child = null
    })
  }

  #receiveChunk(chunk: Buffer) {
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk])
    if (this.#stdoutBuffer.length > this.#maxLineBytes) {
      const newlineIndex = this.#stdoutBuffer.indexOf(0x0a)
      if (newlineIndex === -1 || newlineIndex > this.#maxLineBytes) {
        this.#failProtocol("The local runtime emitted an oversized message.")
        return
      }
    }

    let newlineIndex = this.#stdoutBuffer.indexOf(0x0a)
    while (newlineIndex >= 0) {
      const line = this.#stdoutBuffer.subarray(0, newlineIndex)
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newlineIndex + 1)
      if (line.length > this.#maxLineBytes) {
        this.#failProtocol("The local runtime emitted an oversized message.")
        return
      }
      this.#receive(line.toString("utf8").replace(/\r$/, ""))
      newlineIndex = this.#stdoutBuffer.indexOf(0x0a)
    }
  }

  #receive(line: string) {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.#invalidLineCount += 1
      if (this.#invalidLineCount >= MAX_INVALID_LINES) {
        this.#failProtocol(
          "The local runtime emitted too many invalid messages."
        )
      }
      return
    }
    this.#invalidLineCount = 0
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      for (const listener of this.#requests) {
        listener(message as RpcMessage & { id: RpcId })
      }
      return
    }
    if (typeof message.id === "number" || typeof message.id === "string") {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.#pending.delete(message.id)
      if (message.error) {
        pending.reject(
          new Error(
            typeof message.error.message === "string"
              ? message.error.message.slice(0, 500)
              : "The local runtime request failed."
          )
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    for (const listener of this.#notifications) listener(message)
  }

  #failProtocol(message: string) {
    const error = new Error(message)
    this.#failAll(error)
    this.stop()
  }

  #failAll(error: Error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  request(method: string, params: Record<string, unknown> = {}) {
    this.start()
    const child = this.#child
    if (!child) return Promise.reject(new Error("The runtime did not start."))
    const id = this.#nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error("The local runtime did not respond in time."))
      }, this.#requestTimeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.start()
    this.#child?.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  subscribe(listener: (message: RpcMessage) => void) {
    this.#notifications.add(listener)
    return () => {
      this.#notifications.delete(listener)
    }
  }

  subscribeRequests(listener: (message: RpcMessage & { id: RpcId }) => void) {
    this.#requests.add(listener)
    return () => {
      this.#requests.delete(listener)
    }
  }

  respond(id: RpcId, result: unknown) {
    this.start()
    this.#child?.stdin.write(`${JSON.stringify({ id, result })}\n`)
  }

  reject(id: RpcId, code: number, message: string) {
    this.start()
    this.#child?.stdin.write(
      `${JSON.stringify({
        id,
        error: { code, message: message.slice(0, 500) },
      })}\n`
    )
  }

  stop() {
    const child = this.#child
    if (!child) return
    this.#child = null
    child.stdin.end()
    terminateProcessTree(child, "SIGTERM")
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        terminateProcessTree(child, "SIGKILL")
      }
    }, this.#gracefulStopMs)
    timer.unref()
    this.#stdoutBuffer = Buffer.alloc(0)
  }
}
