import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { workspaceInvitationLifecycleV1 } from "@/workflows/invitation-workflow"

describe("business workflow durability boundary", () => {
  it("accepts only the Forge-owned business run id", () => {
    expect(workspaceInvitationLifecycleV1.length).toBe(1)
    expect(workspaceInvitationLifecycleV1.name).toBe(
      "workspaceInvitationLifecycleV1"
    )
  })

  it("keeps durable orchestration and structured logs free of invitation PII", async () => {
    const [workflowSource, stepSource] = await Promise.all([
      readFile(resolve(import.meta.dirname, "invitation-workflow.ts"), "utf8"),
      readFile(
        resolve(import.meta.dirname, "invitation-workflow-steps.ts"),
        "utf8"
      ),
    ])

    expect(workflowSource).not.toMatch(/\bemail\b/i)
    expect(workflowSource).not.toMatch(/agent|eve/i)
    expect(stepSource).not.toMatch(/console\.(?:debug|error|info|log|warn)/)
  })

  it("keeps stable Workflow SDK ownership out of the EVE package", async () => {
    const evePackage = JSON.parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../../../../services/agent-runtime/package.json"
        ),
        "utf8"
      )
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(evePackage.dependencies?.workflow).toBeUndefined()
    expect(evePackage.devDependencies?.workflow).toBeUndefined()
  })
})
