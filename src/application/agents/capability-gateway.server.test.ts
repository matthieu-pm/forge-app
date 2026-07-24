import { describe, expect, it, vi  } from "vitest"
import { z } from "zod"

import type { Actor } from "@/application/actor"
import {
  CapabilityGateway,
  CapabilityRegistry,
  defineCapability,
} from "@/application/agents/capability-gateway.server"
import { InMemoryCapabilityIdempotencyStore } from "@/adapters/agents/in-memory-capability-idempotency-store"

const RUN_ID = "00000000-0000-4000-8000-000000000001"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: {
    kind: "agent",
    runId: RUN_ID,
    tokenId: "00000000-0000-4000-8000-000000000002",
  },
  scopes: ["teams:read"],
}

function gateway(
  risk: "read" | "reversible-write" = "read",
  options: ConstructorParameters<typeof CapabilityGateway>[1] = {},
  execute = vi.fn((_actor: Actor, input: { limit: number }) =>
    Promise.resolve({ count: input.limit })
  )
) {
  return new CapabilityGateway(
    new CapabilityRegistry([
      defineCapability({
        descriptor: {
          id: "teams.list",
          version: "1",
          summary: "List teams.",
          risk,
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          maxResultBytes: 1024,
        },
        inputSchema: z.object({ limit: z.number().int() }).strict(),
        outputSchema: z.object({ count: z.number().int() }).strict(),
        execute,
      }),
    ]),
    options
  )
}

describe("capability gateway", () => {
  it("validates and invokes a registered read capability", async () => {
    await expect(
      gateway().invoke(
        actor,
        {
          capabilityId: "teams.list",
          capabilityVersion: "1",
          input: { limit: 3 },
        },
        { runId: RUN_ID }
      )
    ).resolves.toEqual({ ok: true, value: { count: 3 } })
  })

  it("requires an idempotency key and approval for writes", async () => {
    await expect(
      gateway("reversible-write").invoke(
        actor,
        {
          capabilityId: "teams.list",
          capabilityVersion: "1",
          input: { limit: 3 },
        },
        { runId: RUN_ID }
      )
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "IDEMPOTENCY_KEY_REQUIRED",
    })
  })

  it("consumes approval once and replays a completed write", async () => {
    const consume = vi.fn().mockResolvedValue({ state: "consumed" })
    const execute = vi.fn((_actor: Actor, input: { limit: number }) =>
      Promise.resolve({ count: input.limit })
    )
    const writeGateway = gateway(
      "reversible-write",
      {
        approvals: { consume },
        idempotency: new InMemoryCapabilityIdempotencyStore(),
      },
      execute
    )
    const invocation = {
      capabilityId: "teams.list",
      capabilityVersion: "1",
      input: { limit: 3 },
      idempotencyKey: "update-team-1",
      approvalId: "80000000-0000-4000-8000-000000000001",
    }

    await expect(
      writeGateway.invoke(actor, invocation, { runId: RUN_ID })
    ).resolves.toEqual({ ok: true, value: { count: 3 } })
    await expect(
      writeGateway.invoke(actor, invocation, { runId: RUN_ID })
    ).resolves.toEqual({ ok: true, value: { count: 3 } })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("correlates an approved EVE write by exact run and input", async () => {
    const approvalId = "80000000-0000-4000-8000-000000000001"
    const consume = vi.fn().mockResolvedValue({ state: "consumed" })
    const findApprovedForInvocation = vi.fn().mockResolvedValue({
      id: approvalId,
    })
    const writeGateway = gateway("reversible-write", {
      approvals: { consume, findApprovedForInvocation },
      idempotency: new InMemoryCapabilityIdempotencyStore(),
    })

    await expect(
      writeGateway.invoke(
        actor,
        {
          capabilityId: "teams.list",
          capabilityVersion: "1",
          input: { limit: 3 },
          idempotencyKey: "eve-write-1",
        },
        { runId: RUN_ID }
      )
    ).resolves.toEqual({ ok: true, value: { count: 3 } })

    expect(findApprovedForInvocation).toHaveBeenCalledWith(actor, {
      runId: RUN_ID,
      capabilityId: "teams.list",
      capabilityVersion: "1",
      capabilityInput: { limit: 3 },
    })
    expect(consume).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ approvalId })
    )
  })

  it("rejects idempotency-key reuse with different input", async () => {
    const writeGateway = gateway("reversible-write", {
      approvals: { consume: vi.fn().mockResolvedValue({}) },
      idempotency: new InMemoryCapabilityIdempotencyStore(),
    })
    const base = {
      capabilityId: "teams.list",
      capabilityVersion: "1",
      idempotencyKey: "update-team-1",
      approvalId: "80000000-0000-4000-8000-000000000001",
    }
    await writeGateway.invoke(
      actor,
      { ...base, input: { limit: 3 } },
      { runId: RUN_ID }
    )
    await expect(
      writeGateway.invoke(
        actor,
        { ...base, input: { limit: 4 } },
        { runId: RUN_ID }
      )
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "IDEMPOTENCY_KEY_CONFLICT",
    })
  })

  it("rejects undeclared capabilities", async () => {
    await expect(
      gateway().invoke(
        actor,
        {
          capabilityId: "teams.delete",
          capabilityVersion: "1",
          input: {},
        },
        { runId: RUN_ID }
      )
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "CAPABILITY_NOT_FOUND",
    })
  })

  it("enforces the admin capability allowlist before dispatch", async () => {
    await expect(
      gateway("read", {
        allowedCapabilities: new Set(["workspace.describe"]),
      }).invoke(
        actor,
        {
          capabilityId: "teams.list",
          capabilityVersion: "1",
          input: { limit: 3 },
        },
        { runId: RUN_ID }
      )
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "POLICY_BLOCKED",
    })
  })
})
