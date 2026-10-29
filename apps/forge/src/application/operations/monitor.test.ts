// @vitest-environment node
import { createServer } from "node:http"
import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  RUNBOOK_URL,
  alertEnvelope,
  deliverAlert,
  evaluateMonitor,
  monitorDestination,
} from "./monitor"
import { dispatchFindings, runMonitor } from "./monitor-runner"
import { handleMonitorRequest } from "./monitor-handler"
import type { MonitorStore } from "./monitor-store"
import type { Finding, Sample } from "./monitor"

const now = Date.parse("2026-10-29T21:00:00Z")
const evaluate = (seconds: number) =>
  evaluateMonitor({
    now,
    jobs: ["agent.retention"],
    heartbeats: [
      { key: "agent.retention", completedAt: now - seconds * 1_000 },
    ],
    samples: [],
    requiredSignals: [],
  })
afterEach(() => vi.restoreAllMocks())

describe("accepted operational alert thresholds", () => {
  it("warns after 30 minutes and pages after 60 minutes without a completed sweep", () => {
    expect(evaluate(1_800)).toEqual([])
    expect(evaluate(1_801)[0]).toMatchObject({
      code: "SWEEP_STALE",
      severity: "warning",
      threshold: 1_800,
    })
    expect(evaluate(3_600)[0].severity).toBe("warning")
    expect(evaluate(3_601)[0]).toMatchObject({
      code: "SWEEP_STALE",
      severity: "page",
      threshold: 3_600,
    })
  })
  it("never treats missing, future or failed heartbeat data as completed work", () => {
    expect(
      evaluateMonitor({
        now,
        jobs: ["agent.retention"],
        heartbeats: [],
        samples: [],
        requiredSignals: [],
      })[0].code
    ).toBe("SIGNAL_MISSING")
    expect(evaluate(-6)[0].code).toBe("SIGNAL_MISSING")
    expect(
      evaluateMonitor({
        now,
        jobs: ["agent.retention"],
        heartbeats: [
          { key: "agent.retention", completedAt: now - 100, failedAt: now },
        ],
        samples: [],
        requiredSignals: [],
      })[0].code
    ).toBe("JOB_FAILED")
  })
  it.each([
    ["event-age", 30, 0],
    ["event-age", 31, 1],
    ["event-age", 61, 1],
    ["outbox-age", 61, 1],
    ["lease-age", 300, 0],
    ["lease-age", 301, 1],
    ["job-age", 3_600, 0],
    ["job-age", 3_601, 1],
    ["failed-upload-age", 3_601, 1],
    ["database-slots", 0, 1],
    ["database-slots", 1, 0],
    ["account-journey", 0, 1],
    ["issue-journey", 1, 0],
  ] as const)("evaluates %s=%s", (key, value, count) => {
    const samples: Array<Sample> = [
      { key, value, observedAt: now, since: now - value * 1_000 },
    ]
    expect(
      evaluateMonitor({
        now,
        jobs: [],
        heartbeats: [],
        samples,
        requiredSignals: [key],
      })
    ).toHaveLength(count)
  })
  it("requires five minutes of sustained backlog saturation", () => {
    const input = {
      now,
      jobs: [],
      heartbeats: [],
      requiredSignals: ["backlog"] as Array<Sample["key"]>,
      samples: [
        {
          key: "backlog" as const,
          value: 0.8,
          observedAt: now,
          since: null,
          highSince: now - 299_999,
        },
      ],
    }
    expect(evaluateMonitor(input)).toEqual([])
    input.samples[0].highSince--
    expect(evaluateMonitor(input)[0].code).toBe("BACKLOG_HIGH")
  })
  it("surfaces missing or stale enabled signals rather than using zero", () => {
    expect(
      evaluateMonitor({
        now,
        jobs: [],
        heartbeats: [],
        samples: [],
        requiredSignals: ["outbox-age"],
      })[0].code
    ).toBe("SIGNAL_MISSING")
    expect(
      evaluateMonitor({
        now,
        jobs: [],
        heartbeats: [],
        samples: [
          {
            key: "event-age",
            value: 0,
            observedAt: now - 120_001,
            since: null,
          },
        ],
        requiredSignals: ["event-age"],
      })[0].code
    ).toBe("SIGNAL_STALE")
  })
  it("keeps stable delivery IDs through retries, with separate warning and page identities", () => {
    const warning = evaluate(2_000)[0]
    const page = { ...warning, severity: "page" as const }
    expect(alertEnvelope(warning, "staging").id).toBe(
      alertEnvelope({ ...warning, value: 2_100 }, "staging").id
    )
    expect(alertEnvelope(warning, "staging").id).not.toBe(
      alertEnvelope(page, "staging").id
    )
    expect(
      JSON.stringify(
        alertEnvelope(
          { ...warning, privateText: "PRIVATE-FIXTURE" } as Finding,
          "staging"
        )
      )
    ).not.toContain("PRIVATE-FIXTURE")
  })
})

describe("operator delivery", () => {
  const env = {
    FORGE_ENVIRONMENT: "development",
    FORGE_OPERATIONS_WEBHOOK_URL: "http://127.0.0.1:1/alerts",
    FORGE_OPERATIONS_WEBHOOK_TOKEN: "x".repeat(43),
  }
  it("delivers a stale scheduled-job alert to a real HTTP receiver, including its runbook", async () => {
    const received: Array<{ headers: Record<string, unknown>; body: unknown }> =
      []
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      received.push({ headers: request.headers, body: JSON.parse(body) })
      response.writeHead(204)
      response.end()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address() as { port: number }
      const alert = alertEnvelope(evaluate(3_601)[0], "development")
      await deliverAlert(alert, {
        ...env,
        FORGE_OPERATIONS_WEBHOOK_URL: `http://127.0.0.1:${address.port}/alerts`,
      })
      expect(received).toHaveLength(1)
      expect(received[0].body).toMatchObject({
        code: "SWEEP_STALE",
        severity: "page",
        runbookUrl: RUNBOOK_URL,
        objectiveVersion: 1,
      })
      expect(received[0].headers["idempotency-key"]).toBe(alert.id)
      expect(received[0].headers.authorization).toBe(
        `Bearer ${env.FORGE_OPERATIONS_WEBHOOK_TOKEN}`
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it("refuses redirects, invalid endpoints and unsuccessful delivery", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500 }))
    await expect(
      deliverAlert(
        alertEnvelope(evaluate(3_601)[0], "development"),
        env,
        fetcher
      )
    ).rejects.toThrow("delivery failed")
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" })
    for (const url of [
      "https://user:secret@alerts.test",
      "https://alerts.test/?secret=private",
      "http://alerts.test/",
      "http://127.0.0.1/",
    ]) {
      expect(() =>
        monitorDestination({
          ...env,
          NODE_ENV: "production",
          FORGE_OPERATIONS_WEBHOOK_URL: url,
        })
      ).toThrow()
    }
  })
  it("does not acknowledge failed delivery and makes it retryable", async () => {
    const store = {
      claim: vi.fn().mockResolvedValue("lease"),
      acknowledge: vi.fn(),
      release: vi.fn(),
    } as unknown as MonitorStore
    const result = await dispatchFindings(
      evaluate(3_601),
      store,
      env,
      vi.fn().mockRejectedValue(new Error("SECRET-FIXTURE"))
    )
    expect(result).toEqual({ delivered: 0, suppressed: 0, failed: 1 })
    expect(store.acknowledge).not.toHaveBeenCalled()
    expect(store.release).toHaveBeenCalledOnce()
  })
  it("suppresses already claimed/delivered findings", async () => {
    const store = {
      claim: vi.fn().mockResolvedValue(null),
    } as unknown as MonitorStore
    const fetcher = vi.fn()
    expect(
      await dispatchFindings(evaluate(3_601), store, env, fetcher)
    ).toEqual({ delivered: 0, suppressed: 1, failed: 0 })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("validates configuration before reading operational data", async () => {
    const store = {
      heartbeats: vi.fn(),
      samples: vi.fn(),
    } as unknown as MonitorStore
    await expect(runMonitor(store, {})).rejects.toThrow()
    expect(store.heartbeats).not.toHaveBeenCalled()
  })
  it("denies anonymous, disabled or wrong-method monitor requests before initialization", async () => {
    const run = vi.fn()
    for (const env of [
      {},
      { CRON_SECRET: "x".repeat(43), FORGE_OPERATIONS_MONITOR_ENABLED: "true" },
    ]) {
      expect(
        (
          await handleMonitorRequest(
            new Request("https://forge.test/api/internal/operations-monitor"),
            env,
            run
          )
        ).status
      ).toBe(404)
    }
    expect(run).not.toHaveBeenCalled()
  })
  it("reports delivery errors as safe noncached failures", async () => {
    const request = new Request("https://forge.test/monitor", {
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
    })
    const result = await handleMonitorRequest(
      request,
      { CRON_SECRET: "x".repeat(43), FORGE_OPERATIONS_MONITOR_ENABLED: "true" },
      async () => {
        throw new Error("postgresql://SECRET-FIXTURE")
      }
    )
    expect(result.status).toBe(503)
    expect(result.headers.get("cache-control")).toBe("no-store")
    expect(await result.text()).not.toContain("SECRET-FIXTURE")
  })
})
