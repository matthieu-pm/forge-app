import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { executeIdempotent } from "./idempotency.server"
import type * as CommandModule from "@/application/commands/execute-command.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import { CommandConflictError } from "@/application/commands/execute-command.server"

const mocks = vi.hoisted(() => ({ execute: vi.fn(), rows: vi.fn() }))
vi.mock(
  "@/application/commands/execute-command.server",
  async (importOriginal) => {
    const actual = await importOriginal<typeof CommandModule>()
    return { ...actual, executeCommand: mocks.execute }
  }
)
vi.mock("@/db", async () => ({ ...(await import("@/db/schema")), db: {} }))
const actor: Actor = {
  userId: "u",
  workspaceId: "w",
  workspaceRole: "owner",
  authentication: { kind: "apiKey", credentialId: "key" },
  scopes: ["teams:read", "teams:write"],
}
const input = { name: "Platform" }
const options = {
  actor,
  idempotencyKey: "create-1",
  operationId: "createTeam",
  input,
  status: 201,
  parse: (v: unknown) => v,
  authorize: vi.fn(),
  run: vi.fn(),
}
const tx = {
  select: () => ({ from: () => ({ where: () => ({ for: mocks.rows }) }) }),
} as unknown as Transaction
beforeEach(() => {
  mocks.execute.mockImplementation((o) => o.legacy(tx))
  mocks.rows.mockResolvedValue([])
})
describe("API command adapter", () => {
  it("delegates the complete transaction contract", async () => {
    await executeIdempotent(options)
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        commandKey: "create-1",
        operation: "createTeam",
        authorize: options.authorize,
        run: options.run,
      })
    )
  })
  it("preserves the original legacy hash and response", async () => {
    mocks.rows.mockResolvedValue([
      {
        requestHash: createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex"),
        responseBody: '{"id":"original"}',
        responseStatus: 201,
      },
    ])
    await expect(executeIdempotent(options)).resolves.toEqual({
      value: { id: "original" },
    })
  })
  it("rejects ambiguous legacy outcomes regardless of expiry", async () => {
    mocks.rows.mockResolvedValue([
      {
        requestHash: createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex"),
        responseBody: null,
        responseStatus: null,
        expiresAt: new Date(0),
      },
    ])
    await expect(executeIdempotent(options)).rejects.toMatchObject({
      reason: "ambiguous",
    })
  })
  it("rejects legacy key reuse", async () => {
    mocks.rows.mockResolvedValue([{ requestHash: "different" }])
    await expect(executeIdempotent(options)).rejects.toBeInstanceOf(
      CommandConflictError
    )
  })
  it("requires an API actor", async () => {
    await expect(
      executeIdempotent({
        ...options,
        actor: {
          ...actor,
          authentication: { kind: "session", sessionId: "s" },
        },
      })
    ).rejects.toThrow("API-key")
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})
