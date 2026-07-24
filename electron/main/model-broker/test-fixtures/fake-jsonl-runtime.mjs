import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const mode = process.argv[2] ?? "normal"
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

lines.on("line", (line) => {
  const message = JSON.parse(line)

  if (mode === "oversized") {
    process.stdout.write("x".repeat(2_048))
    return
  }

  if (mode === "invalid") {
    for (let index = 0; index < 20; index += 1) {
      process.stdout.write("not-json\n")
    }
    return
  }

  if (message.method === "spawn-grandchild") {
    const grandchild = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      }
    )
    send({ id: message.id, result: { pid: grandchild.pid } })
    return
  }

  if (message.method === "trigger-server-request") {
    send({ id: message.id, result: { triggered: true } })
    send({ method: "test/notification", params: { value: 1 } })
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "git status" },
    })
    return
  }

  if (message.id === "approval-1" && "result" in message) {
    send({
      method: "test/server-response",
      params: { result: message.result },
    })
    return
  }

  if (typeof message.id === "number") {
    send({
      id: message.id,
      result: { method: message.method, params: message.params },
    })
  }
})
