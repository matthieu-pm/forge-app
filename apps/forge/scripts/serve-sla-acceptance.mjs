import { connect } from "node:net"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

// A loopback-only WebSocket/TCP bridge lets the unchanged Neon application
// driver exercise a disposable local PostgreSQL server. No production secrets.
const app = fileURLToPath(new URL("../", import.meta.url))
const bridge = Bun.serve({
  hostname: "127.0.0.1",
  port: 56526,
  fetch(request, server) {
    if (
      server.upgrade(request, {
        data: { socket: undefined, pending: [], connected: false },
      })
    )
      return
    return new Response(null, { status: 404 })
  },
  websocket: {
    open(ws) {
      const socket = connect({ host: "127.0.0.1", port: 56525 })
      ws.data.socket = socket
      socket.on("connect", () => {
        ws.data.connected = true
        for (const b of ws.data.pending) socket.write(b)
        ws.data.pending = []
      })
      socket.on("data", (data) => ws.send(data))
      socket.on("error", () => ws.close())
      socket.on("close", () => ws.close())
    },
    message(ws, message) {
      const b = Buffer.from(message)
      if (ws.data.connected) ws.data.socket.write(b)
      else ws.data.pending.push(b)
    },
    close(ws) {
      ws.data.socket?.destroy()
    },
  },
})
const program = `
  const bundle = await import('./.output/server/_libs/neondatabase__serverless.mjs');
  const config = Object.values(bundle).find(v => typeof v === 'function' && 'wsProxy' in v);
  if (!config) throw new Error('Built Neon configuration not found');
  config.webSocketConstructor = WebSocket;
  config.useSecureWebSocket = false;
  config.pipelineConnect = false;
  config.wsProxy = () => '127.0.0.1:56526';
  await import('./.output/server/index.mjs');
`
const child = spawn("node", ["--input-type=module", "-e", program], {
  cwd: app,
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOST: "127.0.0.1",
    PORT: "3125",
    NODE_ENV: "development",
    FORGE_ENVIRONMENT: "development",
    DATABASE_URL: "postgresql://for125_test@127.0.0.1:56525/for125_sla_test",
    BETTER_AUTH_URL: "http://localhost:3125",
    BETTER_AUTH_SECRET:
      "for125-local-fixture-only-secret-abcdefghijklmnopqrstuvwxyz",
    FORGE_FEATURE_AGENT_UI: "false",
    FORGE_CALLS_ENABLED: "false",
    FORGE_DESKTOP_RELEASE_ENABLED: "false",
    FORGE_BILLING_ENABLED: "false",
    FORGE_FEATURE_ROLLOUTS: JSON.stringify({
      sla: { mode: "enabled", workspaceIds: ["for125-browser-acceptance"] },
    }),
  },
})
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal))
child.on("exit", (code) => {
  bridge.stop(true)
  process.exit(code ?? 1)
})
