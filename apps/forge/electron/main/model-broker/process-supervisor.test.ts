import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { JsonLineProcess } from "./process-supervisor"
import type { RpcId, RpcMessage } from "./process-supervisor"

const fixturePath = resolve(
  process.cwd(),
  "electron/main/model-broker/test-fixtures/fake-jsonl-runtime.mjs"
)

const processes: Array<JsonLineProcess> = []

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    // Linux CI containers may leave stopped descendants as zombies until PID 1
    // reaps them. A zombie still has a PID, but cannot execute any more work.
    if (process.platform === "linux") {
      return !/^State:\s+[ZX]\b/m.test(
        readFileSync(`/proc/${pid}/status`, "utf8")
      )
    }
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH" || code === "ENOENT") return false
    throw error
  }
}

function createProcess(
  mode = "normal",
  options: ConstructorParameters<typeof JsonLineProcess>[3] = {}
) {
  const process_ = new JsonLineProcess(
    process.execPath,
    [fixturePath, mode],
    process.cwd(),
    options
  )
  processes.push(process_)
  return process_
}

function waitFor<T>(
  register: (resolve: (value: T) => void) => () => void,
  timeoutMs = 2_000
) {
  return new Promise<T>((resolve, reject) => {
    let unsubscribe = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error("Timed out waiting for test event."))
    }, timeoutMs)
    unsubscribe = register((value) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    })
  })
}

afterEach(() => {
  for (const process_ of processes.splice(0)) process_.stop()
})

describe("JsonLineProcess", () => {
  it("round-trips requests without using a shell", async () => {
    const process_ = createProcess()

    await expect(process_.request("hello", { value: 1 })).resolves.toEqual({
      method: "hello",
      params: { value: 1 },
    })
  })

  it("separates notifications from server-initiated requests", async () => {
    const process_ = createProcess()
    const notification = waitFor((resolve) =>
      process_.subscribe((message) => {
        if (message.method === "test/notification") resolve(message)
      })
    )
    const request = waitFor<RpcMessage & { id: RpcId }>((resolve) =>
      process_.subscribeRequests((message) => resolve(message))
    )

    await process_.request("trigger-server-request")

    await expect(notification).resolves.toMatchObject({
      method: "test/notification",
    })
    const serverRequest = await request
    expect(serverRequest).toMatchObject({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
    })

    const responseNotification = waitFor((resolve) =>
      process_.subscribe((message) => {
        if (message.method === "test/server-response") resolve(message)
      })
    )
    process_.respond(serverRequest.id, { decision: "decline" })
    await expect(responseNotification).resolves.toMatchObject({
      params: { result: { decision: "decline" } },
    })
  })

  it("fails closed on oversized messages", async () => {
    const process_ = createProcess("oversized", {
      maxLineBytes: 1_024,
      requestTimeoutMs: 2_000,
    })

    await expect(process_.request("oversized")).rejects.toThrow(
      "oversized message"
    )
  })

  it("fails closed after repeated invalid JSON", async () => {
    const process_ = createProcess("invalid", { requestTimeoutMs: 2_000 })

    await expect(process_.request("invalid")).rejects.toThrow(
      "too many invalid messages"
    )
  })

  it.runIf(process.platform !== "win32")(
    "terminates the spawned process group",
    async () => {
      const process_ = createProcess()
      const result = (await process_.request("spawn-grandchild")) as {
        pid: number
      }

      expect(isProcessRunning(result.pid)).toBe(true)
      process_.stop()

      await expect
        .poll(
          () => isProcessRunning(result.pid),
          { timeout: 3_000 }
        )
        .toBe(false)
    }
  )
})
