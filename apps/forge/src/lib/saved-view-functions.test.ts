import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadViewProjectQuery, loadViewProjects } from "./saved-view-functions"
import { newCustomView } from "./custom-views"
import { viewDefinition } from "./saved-view-contract"

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  query: vi.fn(),
  header: vi.fn(),
}))
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (run: () => Promise<unknown>) => run,
    validator: (schema: { parse: (value: unknown) => unknown }) => ({
      handler:
        (run: (options: { data: unknown }) => Promise<unknown>) =>
        (options: { data: unknown }) =>
          run({ data: schema.parse(options.data) }),
    }),
  }),
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://forge.example/workspace/views"),
  setResponseHeader: mocks.header,
}))
vi.mock("@/adapters/auth/session-actor.server", () => ({
  requireSessionActor: mocks.actor,
}))
vi.mock("@/application/views/saved-views.server", () => ({
  queryViewProjects: mocks.query,
}))
const actor = {
  workspaceId: "workspace",
  userId: "alice",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session" },
  scopes: null,
}
const project = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Visible project",
  teamIds: [],
  status: "Planned",
  health: "On track",
}
const result = {
  projects: [project],
  authorizedProjectIds: [project.id, "00000000-0000-4000-8000-000000000002"],
}
const data = {
  workspaceId: "workspace",
  sessionId: "session",
  definition: viewDefinition(newCustomView("projects", "alice")),
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actor.mockResolvedValue(actor)
  mocks.query.mockResolvedValue(result)
})
describe("Saved project server-function release compatibility", () => {
  it("keeps the already released loadViewProjects response as a JSON array", async () => {
    expect(JSON.parse(await loadViewProjects({ data }))).toEqual([project])
    expect(mocks.query).toHaveBeenCalledWith(actor, data.definition)
    expect(mocks.header).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store"
    )
  })
  it("exposes filtered rows and separate unfiltered authorization to the versioned caller", async () => {
    expect(JSON.parse(await loadViewProjectQuery({ data }))).toEqual(result)
    expect(mocks.query).toHaveBeenCalledWith(actor, data.definition)
    expect(mocks.header).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store"
    )
  })
  for (const [name, call] of [
    ["legacy", loadViewProjects],
    ["authority DTO", loadViewProjectQuery],
  ] as const) {
    it.each([{ workspaceId: "other" }, { sessionId: "other" }])(
      `${name} transport rechecks the active identity for %j`,
      async (changed) => {
        await expect(call({ data: { ...data, ...changed } })).rejects.toThrow(
          "active session changed"
        )
        expect(mocks.query).not.toHaveBeenCalled()
      }
    )
  }
})
