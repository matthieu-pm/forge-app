import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Actor } from "@/application/actor"
import {
  IdempotencyConflictError,
  executeIdempotent,
} from "@/api/v1/idempotency.server"

const mocks = vi.hoisted(() => ({
  deleteWhere: vi.fn(),
  insertValues: vi.fn(),
  reservationReturning: vi.fn(),
  selectLimit: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}))

vi.mock("@/db", () => ({
  apiIdempotencyKeys: {
    id: "id",
    workspaceId: "workspaceId",
    credentialId: "credentialId",
    operationId: "operationId",
    idempotencyKey: "idempotencyKey",
    requestHash: "requestHash",
    expiresAt: "expiresAt",
  },
  db: {
    delete: () => ({ where: mocks.deleteWhere }),
    insert: () => ({
      values: (values: unknown) => {
        mocks.insertValues(values)
        return {
          onConflictDoNothing: () => ({
            returning: mocks.reservationReturning,
          }),
        }
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: mocks.selectLimit }) }),
    }),
    update: () => ({
      set: (values: unknown) => {
        mocks.updateSet(values)
        return { where: mocks.updateWhere }
      },
    }),
  },
}))

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: Array<unknown>) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  lt: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}))

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "owner",
  authentication: { kind: "apiKey", credentialId: "key-1" },
  scopes: ["teams:read", "teams:write"],
}

describe("public API idempotency", () => {
  beforeEach(() => {
    mocks.deleteWhere.mockResolvedValue(undefined)
    mocks.reservationReturning.mockResolvedValue([{ id: "reservation-1" }])
    mocks.updateWhere.mockResolvedValue(undefined)
  })

  it("reserves, executes, and stores a successful response", async () => {
    const run = vi.fn().mockResolvedValue({ id: "team-1" })

    await expect(
      executeIdempotent({
        actor,
        idempotencyKey: "import-1",
        input: { name: "Platform" },
        operationId: "createTeam",
        status: 201,
        parse: (value) => value as { id: string },
        run,
      })
    ).resolves.toEqual({ replayed: false, value: { id: "team-1" } })

    expect(run).toHaveBeenCalledOnce()
    expect(mocks.updateSet).toHaveBeenCalledWith({
      responseStatus: 201,
      responseBody: '{"id":"team-1"}',
    })
  })

  it("replays the stored response without rerunning the operation", async () => {
    let capturedHash = ""
    mocks.reservationReturning.mockImplementationOnce(() => {
      capturedHash = (
        mocks.insertValues.mock.calls.at(-1)?.[0] as { requestHash: string }
      ).requestHash
      return Promise.resolve([])
    })
    mocks.selectLimit.mockImplementation(() =>
      Promise.resolve([
        {
          requestHash: capturedHash,
          responseBody: '{"id":"team-1"}',
        },
      ])
    )
    const run = vi.fn()

    await expect(
      executeIdempotent({
        actor,
        idempotencyKey: "import-1",
        input: { name: "Platform" },
        operationId: "createTeam",
        status: 201,
        parse: (value) => value as { id: string },
        run,
      })
    ).resolves.toEqual({ replayed: true, value: { id: "team-1" } })
    expect(run).not.toHaveBeenCalled()
  })

  it("rejects reuse with another payload", async () => {
    mocks.reservationReturning.mockResolvedValue([])
    mocks.selectLimit.mockResolvedValue([
      { requestHash: "another-hash", responseBody: '{"id":"team-1"}' },
    ])

    await expect(
      executeIdempotent({
        actor,
        idempotencyKey: "import-1",
        input: { name: "Different" },
        operationId: "createTeam",
        status: 201,
        parse: (value) => value,
        run: vi.fn(),
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })
})
