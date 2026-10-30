// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { startedAssignmentEnabled } from "./started-assignment.server"

afterEach(() => vi.unstubAllEnvs())
describe("started assignment release gate", () => {
  it.each([
    [undefined, "true", false],
    ["false", "true", false],
    ["1", "true", false],
    ["true", undefined, false],
    ["true", "false", false],
    ["true", "true", true],
  ])("automation=%s sync=%s enables=%s", (automation, sync, enabled) => {
    vi.stubEnv("FORGE_ASSIGN_STARTED_ISSUES_ENABLED", automation)
    vi.stubEnv("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED", sync)
    expect(startedAssignmentEnabled()).toBe(enabled)
  })
})
