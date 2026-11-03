import { PgDialect } from "drizzle-orm/pg-core"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { readPersonDirectory } from "./person-directory.server"
import type { Actor } from "@/application/actor"

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  select: vi.fn(),
  where: vi.fn(),
}))
vi.mock("@/application/commands/command-actor.server", () => ({
  currentCommandActor: mocks.current,
}))
vi.mock("@/application/commands/execute-command.server", () => ({
  executeCommand: vi.fn(),
}))
vi.mock("@/db", async () => ({
  ...(await import("@/db/auth-schema")),
  accountPreferences: {},
  workspacePreferences: {},
  db: {
    transaction: (callback: (tx: unknown) => unknown) =>
      callback({ select: mocks.select }),
  },
}))
const actor: Actor = {
  userId: "viewer",
  workspaceId: "workspace",
  workspaceRole: "member",
  scopes: null,
  authentication: { kind: "session", sessionId: "session" },
}
const scope = { workspaceId: "workspace", sessionId: "session" }
beforeEach(() => {
  vi.stubEnv("FORGE_PERSON_NAME_FORMATTING_ENABLED", "true")
  vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", "true")
  mocks.current.mockReset().mockResolvedValue(actor)
  mocks.select.mockReset().mockReturnValue({
    from: () => ({ innerJoin: () => ({ where: mocks.where }) }),
  })
  mocks.where
    .mockReset()
    .mockResolvedValue([
      { id: "account", name: "Current", username: "current" },
    ])
})
afterEach(() => vi.unstubAllEnvs())

it("projects only public name fields and filters by the live actor's workspace", async () => {
  expect(await readPersonDirectory(actor, scope)).toEqual({
    enabled: true,
    people: [{ id: "account", name: "Current", username: "current" }],
  })
  expect(Object.keys(mocks.select.mock.calls[0][0])).toEqual([
    "id",
    "name",
    "username",
  ])
  const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0])
  expect(query.params).toEqual([actor.workspaceId])
  expect(query.sql).toContain('"organization_id"')
  expect(mocks.current).toHaveBeenCalledWith(expect.anything(), actor)
})

it("rejects another session or workspace and non-session actors before querying names", async () => {
  await expect(
    readPersonDirectory(actor, { ...scope, workspaceId: "other" })
  ).rejects.toThrow()
  await expect(
    readPersonDirectory(actor, { ...scope, sessionId: "other" })
  ).rejects.toThrow()
  await expect(
    readPersonDirectory(
      { ...actor, authentication: { kind: "apiKey", credentialId: "key" } },
      scope
    )
  ).rejects.toThrow()
  expect(mocks.select).not.toHaveBeenCalled()
})

it("rechecks session and workspace after resolving live authorization", async () => {
  mocks.current.mockResolvedValueOnce({ ...actor, workspaceId: "changed" })
  await expect(readPersonDirectory(actor, scope)).rejects.toThrow()
  mocks.current.mockResolvedValueOnce({
    ...actor,
    authentication: { kind: "session", sessionId: "changed" },
  })
  await expect(readPersonDirectory(actor, scope)).rejects.toThrow()
  mocks.current.mockRejectedValueOnce(new Error("Membership revoked"))
  await expect(readPersonDirectory(actor, scope)).rejects.toThrow(
    "Membership revoked"
  )
  expect(mocks.select).not.toHaveBeenCalled()
})

it.each([
  "FORGE_PERSON_NAME_FORMATTING_ENABLED",
  "FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED",
])("withholds the directory when %s is disabled", async (gate) => {
  vi.stubEnv(gate, "false")
  expect(await readPersonDirectory(actor, scope)).toEqual({
    enabled: false,
    people: [],
  })
  expect(mocks.select).not.toHaveBeenCalled()
})
