import { describe, expect, it } from "vitest"

import { canRetryInvitationWorkflowRun } from "@/application/workflows/invitation-workflow-policy"

describe("invitation workflow retry policy", () => {
  it.each(["queued", "starting", "failed-to-start"])(
    "allows the same unclaimed %s business run",
    (state) => {
      expect(canRetryInvitationWorkflowRun({ sdkRunId: null, state })).toBe(
        true
      )
    }
  )

  it.each(["running", "completed", "failed", "cancelled"])(
    "does not mutate a terminal or claimed %s run",
    (state) => {
      expect(canRetryInvitationWorkflowRun({ sdkRunId: null, state })).toBe(
        false
      )
    }
  )

  it("does not retry a run after an SDK run has claimed it", () => {
    expect(
      canRetryInvitationWorkflowRun({
        sdkRunId: "wrun_internal",
        state: "failed-to-start",
      })
    ).toBe(false)
  })
})
