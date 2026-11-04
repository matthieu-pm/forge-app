import { describe, expect, it } from "vitest"
import { emptyPreferenceSnapshot } from "./account-preference-contract"
import {
  assertPreferenceSourceUnchanged,
  discoverPreferenceSources,
} from "./preference-import-client"
import {
  inspectPreferenceSource,
  preferenceSourceFingerprint,
  validatePreferenceImportPlan,
} from "./preference-import-contract"
import type { PreferenceImportSource } from "./preference-import-contract"

const general = (raw: string): PreferenceImportSource => ({
  location: "local",
  key: "forge.personal-preferences",
  raw,
})
describe("FOR-144 preference source contract", () => {
  it("keeps valid explicit fields, excluding invalid fields, unknowns and device facts without inventing defaults", () => {
    const source = general(
      '{"version":1,"values":{"interfaceTheme":"dark","fontSize":"giant","cameraPermission":true,"future":42}}'
    )
    const result = inspectPreferenceSource(source, "alice")
    expect(result.fields).toEqual({ "general.interfaceTheme": "dark" })
    expect(result.exclusions).toHaveLength(3)
    expect(source.raw).toContain('"fontSize":"giant"')
    expect(
      inspectPreferenceSource(
        {
          location: "local",
          key: "forge:notifications:v1:alice",
          raw: '{"updates":{"marketing":true,"legal":"no"},"channels":{"desktop":{"enabled":false}}}',
        },
        "alice"
      ).fields
    ).toEqual({
      "notifications.updates.marketing": true,
      "notifications.channels.desktop.enabled": false,
    })
    expect(
      inspectPreferenceSource(
        {
          location: "saved",
          key: "forge:calls-and-transcripts:v1:alice",
          raw: '{"language":"fr","recordingMode":"ask"}',
        },
        "alice"
      ).fields
    ).toEqual({ "calls.language": "fr", "calls.recordingMode": "ask" })
  })
  it.each([
    "{broken",
    "null",
    '{"version":9,"values":{"interfaceTheme":"dark"}}',
    '{"version":1,"values":[]}',
  ])(
    "preserves unsupported/corrupt bytes and excludes all fields: %s",
    (raw) => {
      const source = general(raw)
      expect(inspectPreferenceSource(source, "alice").fields).toEqual({})
      expect(source.raw).toBe(raw)
    }
  )
  it("excludes other accounts before reading their payload, including future source versions", () => {
    const getItem = (key: string) => {
      if (key.includes("bob")) throw new Error("must not read")
      return '{"language":"fr"}'
    }
    const storage = {
      length: 2,
      key: (i: number) =>
        [
          "forge:calls-and-transcripts:v1:bob",
          "forge:calls-and-transcripts:v9:alice",
        ][i],
      getItem,
    }
    const result = discoverPreferenceSources(
      [{ location: "local", storage }],
      "alice"
    )
    expect(result.excludedAccounts).toBe(1)
    expect(inspectPreferenceSource(result.sources[0], "alice").fields).toEqual(
      {}
    )
  })
  it("fingerprints exact original bytes and refuses changed or removed sources", async () => {
    const source = general('{ "interfaceTheme": "dark" }')
    const fingerprint = await preferenceSourceFingerprint(source)
    const storage = {
      length: 1,
      key: () => source.key,
      getItem: () => source.raw,
    }
    await expect(
      assertPreferenceSourceUnchanged(source, storage, fingerprint)
    ).resolves.toBeUndefined()
    await expect(
      assertPreferenceSourceUnchanged(
        source,
        { ...storage, getItem: () => '{"interfaceTheme":"dark"}' },
        fingerprint
      )
    ).rejects.toThrow(/source changed/)
    await expect(
      assertPreferenceSourceUnchanged(
        source,
        { ...storage, getItem: () => null },
        fingerprint
      )
    ).rejects.toThrow(/source changed/)
  })
  it("requires account ownership and an explicit decision for every supported field", async () => {
    const source = general('{"interfaceTheme":"dark","fontSize":"large"}')
    const plan = {
      id: crypto.randomUUID(),
      identity: { userId: "alice", sessionId: "s", workspaceId: "w" },
      source,
      fingerprint: await preferenceSourceFingerprint(source),
      ownershipConfirmed: true,
      snapshot: emptyPreferenceSnapshot("alice"),
      choices: {
        "general.interfaceTheme": "import",
        "general.fontSize": "keep",
      },
    }
    expect(validatePreferenceImportPlan(plan)).toEqual(plan)
    expect(() =>
      validatePreferenceImportPlan({ ...plan, ownershipConfirmed: false })
    ).toThrow()
    expect(() =>
      validatePreferenceImportPlan({
        ...plan,
        choices: { "general.interfaceTheme": "import" },
      })
    ).toThrow(/every supported field/)
    expect(() =>
      validatePreferenceImportPlan({
        ...plan,
        snapshot: emptyPreferenceSnapshot("bob"),
      })
    ).toThrow(/destination account/)
    expect(() =>
      validatePreferenceImportPlan({
        ...plan,
        choices: { ...plan.choices, "agent.guidance": "import" },
      })
    ).toThrow()
  })
  it("recovers private saved conflict copies and fences changes to their container bytes", async () => {
    const raw = '{"language":"fr"}'
    const key = "forge:legacy-conflict:v1:example"
    const wrapper = JSON.stringify({
      key: "forge:calls-and-transcripts:v1:alice",
      value: raw,
    })
    const storage = { length: 1, key: () => key, getItem: () => wrapper }
    const result = discoverPreferenceSources(
      [{ location: "saved", storage }],
      "alice"
    )
    expect(result.sources).toHaveLength(1)
    expect(inspectPreferenceSource(result.sources[0], "alice").fields).toEqual({
      "calls.language": "fr",
    })
    const fingerprint = await preferenceSourceFingerprint(result.sources[0])
    await expect(
      assertPreferenceSourceUnchanged(result.sources[0], storage, fingerprint)
    ).resolves.toBeUndefined()
    await expect(
      assertPreferenceSourceUnchanged(
        result.sources[0],
        { ...storage, getItem: () => wrapper + " " },
        fingerprint
      )
    ).rejects.toThrow(/source changed/)
    expect(
      inspectPreferenceSource({ ...result.sources[0], raw: "{}" }, "alice")
        .fields
    ).toEqual({})
    expect(
      discoverPreferenceSources([{ location: "saved", storage }], "bob").sources
    ).toHaveLength(0)
  })
})
