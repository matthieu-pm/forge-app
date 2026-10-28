import { describe, expect, it } from "vitest"
import { workspaceUsagePeriod } from "./workspace-usage-period"

function free(anchor: string, now: string) {
  return workspaceUsagePeriod("w", new Date(now), {
    kind: "free",
    workspaceCreatedAt: new Date(anchor),
  })
}
describe("workspace anniversary usage periods", () => {
  it("keeps one trial window across calendar months, anniversaries and retries", () => {
    const source = {
      kind: "trial" as const,
      trialStartedAt: new Date("2026-01-31T12:00:00Z"),
    }
    const first = workspaceUsagePeriod("w", source.trialStartedAt, source)
    const later = workspaceUsagePeriod(
      "w",
      new Date("2026-02-10T12:00:00Z"),
      source
    )
    expect(first.start.toISOString()).toBe("2026-01-31T12:00:00.000Z")
    expect(first.end.toISOString()).toBe("2026-02-14T12:00:00.000Z")
    expect(later.key).toBe(first.key)
    expect(
      workspaceUsagePeriod("other", source.trialStartedAt, source).key
    ).not.toBe(first.key)
  })
  it("closes trial usage exactly at 14 days instead of opening another pool", () => {
    const source = {
      kind: "trial" as const,
      trialStartedAt: new Date("2026-03-22T12:00:00Z"),
    }
    expect(() =>
      workspaceUsagePeriod("w", new Date("2026-04-05T11:59:59.999Z"), source)
    ).not.toThrow()
    expect(() =>
      workspaceUsagePeriod("w", new Date("2026-04-05T12:00:00Z"), source)
    ).toThrow("Trial")
    expect(() =>
      workspaceUsagePeriod("w", new Date("2026-05-01T12:00:00Z"), source)
    ).toThrow("Trial")
  })
  it("rejects future or corrupt trial timestamps without a calendar fallback", () => {
    expect(() =>
      workspaceUsagePeriod("w", new Date("2026-01-01"), {
        kind: "trial",
        trialStartedAt: new Date("2026-01-02"),
      })
    ).toThrow()
    expect(() =>
      workspaceUsagePeriod("w", new Date("2026-01-01"), {
        kind: "trial",
        trialStartedAt: new Date("invalid"),
      })
    ).toThrow()
  })
  it("uses workspace signup time, not calendar month or actor signup", () => {
    const period = free("2026-01-15T14:30:00Z", "2026-03-01T00:00:00Z")
    expect(period.start.toISOString()).toBe("2026-02-15T14:30:00.000Z")
    expect(period.end.toISOString()).toBe("2026-03-15T14:30:00.000Z")
  })
  it("clamps January 31 in February without permanently drifting to the 28th", () => {
    const feb = free("2026-01-31T12:00:00Z", "2026-02-28T12:00:00Z")
    expect(feb.start.toISOString()).toBe("2026-02-28T12:00:00.000Z")
    expect(feb.end.toISOString()).toBe("2026-03-31T12:00:00.000Z")
    expect(
      free(
        "2026-01-31T12:00:00Z",
        "2026-02-28T11:59:59.999Z"
      ).start.toISOString()
    ).toBe("2026-01-31T12:00:00.000Z")
  })
  it("handles leap day and year transitions using the original anchor", () => {
    expect(
      free("2024-02-29T09:00:00Z", "2025-02-28T09:00:00Z").end.toISOString()
    ).toBe("2025-03-29T09:00:00.000Z")
    expect(
      free("2025-12-31T09:00:00Z", "2026-01-31T09:00:00Z").end.toISOString()
    ).toBe("2026-02-28T09:00:00.000Z")
  })
  it("uses half-open windows and stable keys at exact reset boundaries", () => {
    const before = free("2026-01-15T10:00:00Z", "2026-02-15T09:59:59.999Z")
    const after = free("2026-01-15T10:00:00Z", "2026-02-15T10:00:00Z")
    expect(before.end.getTime()).toBe(after.start.getTime())
    expect(before.key).not.toBe(after.key)
    expect(after.key).toBe(
      free("2026-01-15T10:00:00Z", "2026-02-16T00:00:00Z").key
    )
  })
  it("uses provider period boundaries for paid workspaces and refuses stale state", () => {
    const source = {
      kind: "paid-monthly" as const,
      currentPeriodStart: new Date("2026-10-19T09:00:00Z"),
      currentPeriodEnd: new Date("2026-11-19T09:00:00Z"),
    }
    const period = workspaceUsagePeriod(
      "w",
      new Date("2026-11-01T00:00:00Z"),
      source
    )
    expect(period.start).toEqual(source.currentPeriodStart)
    expect(period.start).not.toBe(source.currentPeriodStart)
    expect(() =>
      workspaceUsagePeriod("w", source.currentPeriodEnd, source)
    ).toThrow("Refresh")
    expect(() =>
      workspaceUsagePeriod("w", new Date("2026-10-01"), source)
    ).toThrow("Refresh")
  })
  it("keeps timezone offset instants stable across daylight-saving changes", () => {
    const period = free(
      "2026-02-28T14:00:00+01:00",
      "2026-03-29T15:00:00+02:00"
    )
    expect(period.start.toISOString()).toBe("2026-03-28T13:00:00.000Z")
    expect(period.end.toISOString()).toBe("2026-04-28T13:00:00.000Z")
  })
  it("rejects invalid/future anchors and separates workspace identities", () => {
    expect(() => free("broken", "2026-01-01")).toThrow()
    expect(() => free("2026-02-01", "2026-01-01")).toThrow()
    expect(() => free("2026-01-01", "broken")).toThrow()
    const source = {
      kind: "free" as const,
      workspaceCreatedAt: new Date("2026-01-01"),
    }
    expect(
      workspaceUsagePeriod("a", new Date("2026-03-01"), source).key
    ).not.toBe(workspaceUsagePeriod("b", new Date("2026-03-01"), source).key)
  })
})
