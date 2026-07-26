import { beforeEach, describe, expect, it, vi } from "vitest"

import { listTeams } from "@/lib/team-state"

const mocks = vi.hoisted(() => ({
  handlers: Array.from({ length: 9 }, () => vi.fn()),
  nextHandler: 0,
}))

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const handler = mocks.handlers[mocks.nextHandler++]
    const builder = {
      inputValidator: () => builder,
      handler: () => handler,
    }

    return builder
  },
}))

describe("listTeams client requests", () => {
  const loadTeams = mocks.handlers[1]

  beforeEach(() => {
    loadTeams.mockReset()
  })

  it("shares an in-flight request across workspace shell consumers", async () => {
    let resolveTeams!: (teams: Array<{ slug: string }>) => void
    const pendingTeams = new Promise<Array<{ slug: string }>>((resolve) => {
      resolveTeams = resolve
    })
    loadTeams.mockReturnValueOnce(pendingTeams)

    const sidebarRequest = listTeams()
    const titleBarRequest = listTeams()

    expect(titleBarRequest).toBe(sidebarRequest)
    expect(loadTeams).toHaveBeenCalledOnce()

    resolveTeams([{ slug: "product" }])
    await expect(sidebarRequest).resolves.toEqual([{ slug: "product" }])

    loadTeams.mockResolvedValueOnce([{ slug: "product" }])
    await listTeams()
    expect(loadTeams).toHaveBeenCalledTimes(2)
  })
})
