import { describe, expect, it } from "vitest"
import { start } from "workflow/api"

import { workflowSmoke } from "@/workflows/workflow-smoke"

describe("Workflow SDK", () => {
  it("runs a workflow in process with an opaque correlation id", async () => {
    const correlationId = crypto.randomUUID()
    const run = await start(workflowSmoke, [correlationId])

    await expect(run.returnValue).resolves.toEqual({
      correlationId,
      state: "ok",
    })
  })
})
