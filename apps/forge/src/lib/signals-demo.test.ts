import { describe, expect, it } from "vitest"
import {
  buildSignalSeries,
  createDemoSessions,
  readSignalsSearch,
  selectSignalSessions,
  signalBreakdown,
  signalChange,
  summarizeSignals,
} from "./signals-demo"
import type { SignalSession } from "./signals-demo"

function session(overrides: Partial<SignalSession>): SignalSession {
  return {
    day: 179,
    user: 1,
    firstDay: 160,
    device: "Desktop",
    browser: "Chrome",
    country: "France",
    source: "Direct",
    plan: "Pro",
    features: ["Search", "Boards"],
    pages: ["/", "/search"],
    ...overrides,
  }
}
const sessions = [
  session({ day: 178 }),
  session({}),
  session({
    user: 2,
    firstDay: 179,
    device: "Mobile",
    plan: "Free",
    features: ["Search"],
  }),
  session({ day: 177, user: 3, firstDay: 177, features: ["Boards"] }),
]

describe("Signals sample analytics", () => {
  it("counts unique users separately from sessions and feature events", () => {
    expect(summarizeSignals(sessions, 178)).toEqual({
      users: 3,
      sessions: 4,
      interactions: 6,
      returning: 2,
    })
  })
  it("counts returning users against the period boundary, not repeat sessions", () => {
    expect(
      summarizeSignals(selectSignalSessions(sessions, 178, 179), 178)
    ).toEqual({ users: 2, sessions: 3, interactions: 5, returning: 1 })
  })
  it("combines date, device, plan, and feature filters", () => {
    expect(
      selectSignalSessions(sessions, 178, 179, {
        device: "Mobile",
        plan: "Free",
        feature: "Search",
      })
    ).toEqual([sessions[2]])
    expect(
      selectSignalSessions(sessions, 178, 179, {
        device: "Mobile",
        feature: "Boards",
      })
    ).toEqual([])
  })
  it("uses unique active users as feature adoption denominator", () => {
    const rows = signalBreakdown(sessions, "features")
    expect(rows.find((row) => row.name === "Search")).toEqual({
      name: "Search",
      count: 2,
      share: (2 / 3) * 100,
    })
    expect(rows.find((row) => row.name === "Boards")?.count).toBe(2)
  })
  it("counts repeated events and page views rather than deduplicating them", () => {
    expect(
      signalBreakdown(sessions, "events").find(
        (row) => row.name === "search_performed"
      )
    ).toEqual({ name: "search_performed", count: 3, share: 50 })
    expect(
      signalBreakdown(sessions, "pages").find((row) => row.name === "/")
    ).toEqual({ name: "/", count: 4, share: 50 })
  })
  it("aligns the previous period by day and includes days with zero activity", () => {
    const current = [session({ day: 178 }), session({ day: 179 })]
    const previous = [session({ day: 176 })]
    expect(
      buildSignalSeries(current, previous, 2, "sessions").map(
        ({ current: currentCount, previous: previousCount }) => [
          currentCount,
          previousCount,
        ]
      )
    ).toEqual([
      [1, 1],
      [1, 0],
    ])
  })
  it("handles empty results and missing comparison baselines", () => {
    expect(summarizeSignals([], 178)).toEqual({
      users: 0,
      sessions: 0,
      interactions: 0,
      returning: 0,
    })
    expect(signalBreakdown([], "features")).toEqual([])
    expect(signalChange(20, 0)).toBeNull()
    expect(signalChange(15, 10)).toBe(50)
  })
  it("only enables preview when explicitly requested", () => {
    expect(readSignalsSearch({ preview: "false" })).toEqual({})
    expect(readSignalsSearch({ preview: "true" })).toEqual({ preview: true })
  })
})

describe("Signals sample behavior", () => {
  const history = createDemoSessions()
  const current = selectSignalSessions(history, 150, 179)
  const previous = selectSignalSessions(history, 120, 149)

  it("keeps first-seen dates consistent across repeated user sessions", () => {
    const firstSeen = new Map<number, number>()
    for (const item of history) {
      if (!firstSeen.has(item.user)) firstSeen.set(item.user, item.day)
      expect(item.firstDay).toBe(firstSeen.get(item.user))
    }
  })

  it("supports every plan on every device rather than linking unrelated attributes", () => {
    for (const plan of ["Free", "Pro", "Enterprise"]) {
      for (const device of ["Desktop", "Mobile", "Tablet"]) {
        expect(
          selectSignalSessions(current, 150, 179, { plan, device }).length
        ).toBeGreaterThan(0)
      }
    }
  })

  it("distinguishes widespread feature adoption from high-volume automation events", () => {
    const adoption = signalBreakdown(current, "features")
    const events = signalBreakdown(current, "events")
    const boards = adoption.find((row) => row.name === "Boards")!
    const automations = adoption.find((row) => row.name === "Automations")!
    expect(automations.count).toBeLessThan(boards.count * 0.2)
    expect(
      events.find((row) => row.name === "automation_run")!.count
    ).toBeGreaterThan(events.find((row) => row.name === "report_viewed")!.count)
    const countries = signalBreakdown(current, "countries")
    expect(countries[0].count).toBeGreaterThan(countries.at(-1)!.count * 5)
  })

  it("varies engagement and user mix rather than scaling one curve for all metrics", () => {
    const series = (
      metric: "users" | "sessions" | "interactions" | "returning"
    ) =>
      buildSignalSeries(current, previous, 30, metric).map((row) => row.current)
    const visits = series("sessions")
    const users = series("users")
    const interactionDepth = series("interactions").map(
      (count, index) => count / visits[index]
    )
    const returningShare = series("returning").map(
      (count, index) => count / users[index]
    )
    expect(
      Math.max(...interactionDepth) / Math.min(...interactionDepth)
    ).toBeGreaterThan(2.5)
    expect(
      Math.max(...returningShare) / Math.min(...returningShare)
    ).toBeGreaterThan(1.5)
  })
})
