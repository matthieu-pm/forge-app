// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentEvent } from "@/application/agents/event-contract"
import { AgentApprovalCard } from "@/components/agent/agent-approval-card"

const approvalId = "90000000-0000-4000-8000-000000000001"

function event(
  type: "approval.requested" | "approval.resolved",
  payload: Record<string, unknown>
): AgentEvent {
  return {
    id:
      type === "approval.requested"
        ? "10000000-0000-4000-8000-000000000001"
        : "10000000-0000-4000-8000-000000000002",
    sourceEventId: type,
    threadId: "20000000-0000-4000-8000-000000000001",
    runId: "30000000-0000-4000-8000-000000000001",
    sequence: type === "approval.requested" ? 1 : 2,
    occurredAt: new Date().toISOString(),
    source: "forge",
    type,
    schemaVersion: 1,
    payload,
  }
}

afterEach(cleanup)

describe("AgentApprovalCard", () => {
  it("allows a reversible action once", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(
      <AgentApprovalCard
        event={event("approval.requested", {
          approvalId,
          capabilityId: "teams.update",
          risk: "reversible-write",
          summary: { summary: "Update the Forge team description" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })}
        onResolve={onResolve}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith(approvalId, "approved")
    )
  })

  it("renders the persisted resolution without actionable buttons", () => {
    render(
      <AgentApprovalCard
        event={event("approval.requested", {
          approvalId,
          capabilityId: "teams.update",
          risk: "reversible-write",
          summary: { summary: "Update the Forge team description" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })}
        resolution={event("approval.resolved", {
          approvalId,
          decision: "denied",
        })}
        onResolve={vi.fn()}
      />
    )

    expect(screen.getByText("Denied")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
  })
})
