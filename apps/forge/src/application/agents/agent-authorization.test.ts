import { describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import {
  canManagePersonalModelConnections,
  canManageWorkspaceModelConnections,
  requireAgentApproval,
  requireAgentRead,
  requireAgentRun,
} from "@/application/agents/agent-authorization"

const sessionOwner: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

describe("agent authorization", () => {
  it("allows first-party sessions through all agent checks", () => {
    expect(() => requireAgentRead(sessionOwner)).not.toThrow()
    expect(() => requireAgentRun(sessionOwner)).not.toThrow()
    expect(() => requireAgentApproval(sessionOwner)).not.toThrow()
  })

  it("enforces individual API-key scopes", () => {
    const actor: Actor = {
      ...sessionOwner,
      authentication: { kind: "apiKey", credentialId: "key-1" },
      scopes: ["agents:read"],
    }

    expect(() => requireAgentRead(actor)).not.toThrow()
    expect(() => requireAgentRun(actor)).toThrow("cannot run agents")
    expect(() => requireAgentApproval(actor)).toThrow(
      "cannot approve agent actions"
    )
  })

  it("allows personal connections by scope but workspace connections by role", () => {
    const member: Actor = {
      ...sessionOwner,
      workspaceRole: "member",
      authentication: { kind: "apiKey", credentialId: "key-2" },
      scopes: ["model-connections:write"],
    }

    expect(canManagePersonalModelConnections(member)).toBe(true)
    expect(canManageWorkspaceModelConnections(member)).toBe(false)
    expect(
      canManageWorkspaceModelConnections({
        ...member,
        workspaceRole: "admin",
      })
    ).toBe(true)
  })
})
