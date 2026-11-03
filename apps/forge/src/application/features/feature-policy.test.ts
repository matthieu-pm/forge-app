// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  parseFeatureRollouts,
  productFeatureMode,
  productFeatures,
} from "@forge/environment/product-features"
import { inspectServiceConfiguration } from "@forge/environment/service-config"
import {
  featureForCapability,
  featureForPath,
  featureForStorageKey,
} from "./feature-policy"
import { featureSnapshot, requireFeatureWrite } from "./features.server"

afterEach(() => vi.unstubAllEnvs())

describe("FOR-103 workspace rollout authority", () => {
  it("defaults every inventoried feature off in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production"])
      for (const feature of Object.keys(productFeatures) as Array<
        keyof typeof productFeatures
      >)
        expect(productFeatureMode(feature, "w1", { NODE_ENV })).toBe("disabled")
  })
  it("AT-02: enables billing only for the explicitly selected workspace", () => {
    vi.stubEnv("FORGE_BILLING_ENABLED", "true")
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({ billing: { mode: "enabled", workspaceIds: ["w1"] } })
    )
    expect(featureSnapshot({ workspaceId: "w1" }).billing).toBe("enabled")
    expect(featureSnapshot({ workspaceId: "w2" }).billing).toBe("disabled")
    expect(() =>
      requireFeatureWrite({ workspaceId: "w1" }, "billing")
    ).not.toThrow()
    expect(() => requireFeatureWrite({ workspaceId: "w2" }, "billing")).toThrow(
      /unavailable/
    )
    vi.stubEnv("FORGE_BILLING_ENABLED", "false")
    expect(() => requireFeatureWrite({ workspaceId: "w1" }, "billing")).toThrow(
      /unavailable/
    )
  })
  it("a workspace preview grant never allows a real write", () => {
    vi.stubEnv(
      "FORGE_FEATURE_ROLLOUTS",
      JSON.stringify({
        signals: { mode: "preview", workspaceIds: ["w1"] },
        reviews: { mode: "preview", workspaceIds: ["w1"] },
      })
    )
    for (const feature of ["signals", "reviews"] as const) {
      expect(featureSnapshot({ workspaceId: "w1" })[feature]).toBe("preview")
      expect(featureSnapshot({ workspaceId: "w2" })[feature]).toBe("disabled")
      expect(() => requireFeatureWrite({ workspaceId: "w1" }, feature)).toThrow(
        /unavailable/
      )
    }
  })
  it.each([
    "",
    "null",
    "[]",
    "true",
    '{"secret-unknown-feature":{}}',
    '{"signals":{"mode":"enabled","workspaceIds":["w1"]}}',
    '{"insights":{"mode":"preview","workspaceIds":["w1"]}}',
    '{"billing":{"mode":"preview","workspaceIds":["w1"]}}',
    '{"billing":{"mode":"enabled","workspaceIds":["*"]}}',
    '{"billing":{"mode":"enabled","workspaceIds":[" w1"]}}',
    '{"billing":{"mode":"enabled","workspaceIds":["w1"],"clientFlag":true}}',
  ])("rejects invalid rollout configuration and fails closed: %s", (raw) => {
    expect(() => parseFeatureRollouts(raw)).toThrow(
      "Invalid FORGE_FEATURE_ROLLOUTS configuration."
    )
    expect(
      productFeatureMode("billing", "w1", {
        FORGE_BILLING_ENABLED: "true",
        FORGE_FEATURE_ROLLOUTS: raw,
      })
    ).toBe("disabled")
    const report = inspectServiceConfiguration(
      { FORGE_FEATURE_ROLLOUTS: raw },
      "app"
    )
    expect(
      report.issues.some((issue) => issue.variable === "FORGE_FEATURE_ROLLOUTS")
    ).toBe(true)
    expect(JSON.stringify(report)).not.toContain("secret-unknown-feature")
  })
  it("uses one path inventory for primary navigation, settings and nested links", () => {
    for (const path of [
      "/workspace/signals",
      "/teams/eng/signals",
      "/settings/signals",
      "/workspace/signals/forged/",
    ])
      expect(featureForPath(path)).toBe("signals")
    for (const path of [
      "/reviews",
      "/reviews/created",
      "/reviews/123",
      "/settings/code-and-reviews",
    ])
      expect(featureForPath(path)).toBe("reviews")
    expect(featureForPath("/workspace/insights")).toBe("insights")
    expect(featureForPath("/teams/eng/insights")).toBe("insights")
    expect(featureForPath("/settings/billing")).toBe("billing")
    expect(featureForPath("/settings/account/agents")).toBe("agentGuidance")
    expect(featureForPath("/settings/teams/eng/agent-skills/new")).toBe(
      "agentGuidance"
    )
    expect(featureForPath("/settings/teams/eng/recurring-issues/new")).toBe(
      "recurringIssues"
    )
    expect(featureForPath("/settings/teams/eng/ai/summaries")).toBe(
      "threadSummaries"
    )
    expect(featureForPath("/settings/teams/eng/ai/updates")).toBe(
      "scheduledUpdates"
    )
    expect(featureForPath("/settings/import-export")).toBeUndefined()
    expect(featureForPath("/teams/eng/issues")).toBeUndefined()
  })
  it("recognizes generic state and tool bypasses without gating core data", () => {
    for (const key of [
      "forge:signals:v1:u:w",
      'forge:signal-documents:v1:["w","u"]',
    ])
      expect(featureForStorageKey(key)).toBe("signals")
    for (const key of [
      'forge:reviews-preview:v1:["w","u"]',
      "forge:review-edits:v1:x",
      "forge:reviews-edits:v1:x",
      "forge:code-reviews:u",
    ])
      expect(featureForStorageKey(key)).toBe("reviews")
    expect(featureForStorageKey("forge:workspace:w:sla-settings")).toBe("sla")
    expect(featureForStorageKey("forge:team-cycles:v1:t")).toBeUndefined()
    expect(featureForCapability("signals.createIssue")).toBe("signals")
    expect(featureForCapability("teams.list")).toBeUndefined()
  })
})
