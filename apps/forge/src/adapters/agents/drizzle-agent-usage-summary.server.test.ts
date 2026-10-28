// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import { DrizzleAgentStore } from "./drizzle-agent-store.server"

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  where: vi.fn(),
}))
vi.mock("@/db", async () => ({
  ...(await import("@/db/schema")),
  db: { select: mocks.select },
}))
beforeEach(() => {
  vi.clearAllMocks()
  const query = {
    from: mocks.from,
    innerJoin: mocks.innerJoin,
    where: mocks.where,
  }
  mocks.select.mockReturnValue(query)
  mocks.from.mockReturnValue(query)
  mocks.innerJoin.mockReturnValue(query)
  mocks.where.mockResolvedValue([{ costMicros: "300", activeRuns: 1 }])
})
describe("Postgres usage-window aggregation", () => {
  it("puts the cost window inside the aggregate without dropping older active runs", async () => {
    const store = new DrizzleAgentStore()
    const start = new Date("2026-01-15"),
      end = new Date("2026-02-15")
    await expect(
      store.summarizeUsage("w", "alice", start, end)
    ).resolves.toEqual({ costMicros: 300, activeRuns: 1 })
    const dialect = new PgDialect()
    const fields = mocks.select.mock.calls[0][0]
    const cost = dialect.sqlToQuery(fields.costMicros)
    expect(cost.sql).toContain("filter (where")
    expect(cost.sql).toContain(">=")
    expect(cost.sql).toContain(" < ")
    expect(cost.params).toHaveLength(2)
    const active = dialect.sqlToQuery(fields.activeRuns)
    expect(active.params).toEqual([])
    const predicate = dialect.sqlToQuery(mocks.where.mock.calls[0][0])
    expect(predicate.params).toEqual(["w", "alice"])
    expect(predicate.sql).not.toContain("created_at")
  })
  it("rejects reversed windows before database access", async () => {
    await expect(
      new DrizzleAgentStore().summarizeUsage(
        "w",
        null,
        new Date("2026-02-01"),
        new Date("2026-01-01")
      )
    ).rejects.toThrow()
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
