import { describe, expect, it } from "vitest"
import {
  isTeamContentDevelopment,
  teamContentFeatureEnabled,
} from "./team-content-feature-policy"

describe("team content release gates", () => {
  it.each([
    { FORGE_ENVIRONMENT: "production" },
    { FORGE_ENVIRONMENT: "staging" },
    { VERCEL_ENV: "production" },
    { VERCEL_ENV: "preview" },
    { NODE_ENV: "production" },
    { FORGE_ENVIRONMENT: "development", VERCEL_ENV: "production" },
    {
      FORGE_SERVICE_ENVIRONMENT: "development",
      FORGE_ENVIRONMENT: "production",
    },
    { FORGE_SERVICE_ENVIRONMENT: "production" },
    { FORGE_ENVIRONMENT: "unknown" },
  ])(
    "requires explicit enablement and denies fixture shortcuts in %j",
    (env) => {
      expect(isTeamContentDevelopment(env)).toBe(false)
      for (const key of [
        "FORGE_TEAM_RESOURCES_ENABLED",
        "FORGE_LOOPS_ENABLED",
        "FORGE_SHARED_DOCUMENTS_ENABLED",
      ] as const) {
        expect(teamContentFeatureEnabled(key, env)).toBe(false)
        expect(teamContentFeatureEnabled(key, { ...env, [key]: "true" })).toBe(
          true
        )
        expect(teamContentFeatureEnabled(key, { ...env, [key]: "false" })).toBe(
          false
        )
      }
    }
  )
  it("keeps local development available and honors explicit local disablement", () => {
    expect(isTeamContentDevelopment({ NODE_ENV: "test" })).toBe(true)
    expect(teamContentFeatureEnabled("FORGE_LOOPS_ENABLED", {})).toBe(true)
    expect(
      teamContentFeatureEnabled("FORGE_LOOPS_ENABLED", {
        FORGE_LOOPS_ENABLED: "false",
      })
    ).toBe(false)
  })
})
