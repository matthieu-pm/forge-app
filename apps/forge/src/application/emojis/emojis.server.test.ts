import { beforeEach, describe, expect, it, vi } from "vitest"
import { addEmoji, listEmojis, removeEmoji } from "./emojis.server"
import type { Actor } from "@/application/actor"

const mocks = vi.hoisted(() => ({
  where: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  returning: vi.fn(),
  policy: vi.fn(),
}))
vi.mock("@/application/workspace-security/workspace-security.server", () => ({
  assertWorkspaceUploadAllowed: mocks.policy,
}))
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
  and: (...conditions: Array<unknown>) => conditions.filter(Boolean),
  isNull: (column: unknown) => ({ column, null: true }),
  asc: (column: unknown) => column,
}))
vi.mock("@/db", () => ({
  workspaceEmojis: {
    id: "id",
    name: "name",
    workspaceId: "workspace",
    createdBy: "creator",
    deletedAt: "deleted",
  },
  users: {},
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: (condition: unknown) => {
            mocks.where(condition)
            return { orderBy: () => Promise.resolve([]) }
          },
        }),
      }),
    }),
    insert: () => ({
      values: (data: unknown) => {
        mocks.insert(data)
        return { onConflictDoNothing: () => ({ returning: mocks.returning }) }
      },
    }),
    update: () => ({
      set: (data: unknown) => {
        mocks.update(data)
        return {
          where: (condition: unknown) => {
            mocks.where(condition)
            return { returning: mocks.returning }
          },
        }
      },
    }),
  },
}))
const member: Actor = {
  userId: "user",
  workspaceId: "workspace-a",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session" },
  scopes: null,
}
const input = { name: "logo", image: "data:image/png;base64,iVBORw0KGgoAAA==" }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.returning.mockResolvedValue([{ id: "id" }])
})
describe("workspace emoji authorization", () => {
  it("scopes directory reads to the active workspace and excludes removed entries", async () => {
    await listEmojis(member)
    expect(mocks.where).toHaveBeenCalledWith([
      { column: "workspace", value: "workspace-a" },
      { column: "deleted", null: true },
    ])
  })
  it("derives upload ownership from the actor and checks the upload policy", async () => {
    await addEmoji(member, input)
    expect(mocks.insert).toHaveBeenCalledWith({
      ...input,
      workspaceId: "workspace-a",
      createdBy: "user",
    })
    expect(mocks.policy).toHaveBeenCalledWith(member, "image/png")
  })
  it("requires ownership for members and still scopes administrator removal", async () => {
    await removeEmoji(member, "target")
    expect(mocks.where.mock.calls[0][0]).toContainEqual({
      column: "creator",
      value: "user",
    })
    expect(mocks.update.mock.calls[0][0].deletedAt).toBeInstanceOf(Date)
    mocks.where.mockClear()
    await removeEmoji({ ...member, workspaceRole: "admin" }, "target")
    expect(mocks.where.mock.calls[0][0]).toContainEqual({
      column: "workspace",
      value: "workspace-a",
    })
    expect(mocks.where.mock.calls[0][0]).not.toContainEqual({
      column: "creator",
      value: "user",
    })
  })
  it("rejects guests and credential-scoped agents before database access", async () => {
    await expect(
      addEmoji({ ...member, workspaceRole: "guest" }, input)
    ).rejects.toThrow("permission")
    await expect(
      listEmojis({
        ...member,
        authentication: { kind: "apiKey", credentialId: "key" },
      })
    ).rejects.toThrow("permission")
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.where).not.toHaveBeenCalled()
  })
  it("reports duplicate names and unauthorized or missing removals", async () => {
    mocks.returning.mockResolvedValue([])
    await expect(addEmoji(member, input)).rejects.toThrow("already exists")
    await expect(removeEmoji(member, "target")).rejects.toThrow(
      "could not be removed"
    )
  })
})
