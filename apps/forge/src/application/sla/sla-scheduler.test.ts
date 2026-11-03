import { describe, expect, it, vi } from "vitest"
import { handleSlaScheduler } from "./sla-scheduler"
import { slaGate } from "./sla-gate"
import {
  initialSharedSlaPolicy,
  sharedSlaPolicySchema,
} from "@/lib/shared-sla-contract"

describe("SLA admission and validation", () => {
  it("starts disabled without preset rules and cannot enable an unlisted workspace", () => {
    expect(initialSharedSlaPolicy()).toEqual({
      enabled: false,
      workWeek: "mon-fri",
      rules: [],
    })
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({ sla: { mode: "enabled", workspaceIds: ["selected"] } })
    )
    try {
      expect(slaGate("selected").enabled).toBe(true)
      expect(slaGate("other").enabled).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it("rejects empty filters, duplicate rule identities and caller-owned timestamps", () => {
    const rule = {
      id: crypto.randomUUID(),
      enabled: true,
      action: "apply",
      filters: {},
      duration: { unit: "hour", value: 24 },
      startMode: "ruleMatch",
    }
    expect(
      sharedSlaPolicySchema.safeParse({
        enabled: true,
        workWeek: "mon-fri",
        rules: [rule],
      }).success
    ).toBe(false)
    rule.filters = { priorities: ["Urgent"] } as typeof rule.filters
    expect(
      sharedSlaPolicySchema.safeParse({
        enabled: true,
        workWeek: "mon-fri",
        rules: [rule, rule],
      }).success
    ).toBe(false)
    expect(
      sharedSlaPolicySchema.safeParse({
        enabled: true,
        workWeek: "mon-fri",
        rules: [{ ...rule, deadline: "2099-01-01" }],
      }).success
    ).toBe(false)
  })
  it("denies wrong method, missing/short/wrong credentials and a disabled scheduler without invoking work", async () => {
    const secret = "fixture-".repeat(8),
      run = vi.fn()
    for (const [method, token, enabled, key] of [
      ["GET", secret, "false", secret],
      ["POST", secret, "true", secret],
      ["GET", "", "true", secret],
      ["GET", "wrong", "true", secret],
      ["GET", "short", "true", "short"],
    ]) {
      const response = await handleSlaScheduler(
        new Request("http://localhost/api/internal/sla-jobs", {
          method,
          headers: { authorization: `Bearer ${token}` },
        }),
        { FORGE_SLA_JOBS_ENABLED: enabled, CRON_SECRET: key },
        run
      )
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    expect(run).not.toHaveBeenCalled()
  })
  it("reports bounded success/failure without leaking input or dependency exceptions", async () => {
    const secret = "fixture-".repeat(8),
      env = { FORGE_SLA_JOBS_ENABLED: "true", CRON_SECRET: secret }
    const request = () =>
      new Request("http://localhost/api/internal/sla-jobs", {
        headers: { authorization: `Bearer ${secret}` },
      })
    const response = await handleSlaScheduler(request(), env, async () => ({
      dispatched: 1,
      results: [{ state: "deferred" }],
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      dispatched: 1,
      processed: 1,
      failed: false,
    })
    expect(
      (
        await handleSlaScheduler(request(), env, async () => ({
          dispatched: 1,
          results: [{ state: "lost" }],
        }))
      ).status
    ).toBe(503)
    const failure = await handleSlaScheduler(request(), env, async () => {
      throw new Error("private database detail")
    })
    expect(await failure.text()).not.toContain("private")
  })
})
