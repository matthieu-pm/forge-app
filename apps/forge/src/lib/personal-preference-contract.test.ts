import { describe, expect, it } from "vitest"
import {
  defaultPersonalPreferences,
  parsePersonalPreferences,
  personalPreferencePatchSchema,
  personalPreferenceScopes,
  preferenceCacheKey,
} from "./personal-preference-contract"

describe("personal preference contract", () => {
  it("recovers valid fields independently and retains unknown source fields", () => {
    const raw = JSON.stringify({
      version: 1,
      values: {
        firstDayOfWeek: "monday",
        pointerCursors: "true",
        fontSize: "giant",
        autoAssignToSelf: true,
        futureField: { keep: true },
      },
    })
    const result = parsePersonalPreferences(raw)
    expect(result.preferences).toEqual({
      ...defaultPersonalPreferences,
      firstDayOfWeek: "monday",
      autoAssignToSelf: true,
    })
    expect(result.invalidFields).toEqual(["fontSize", "pointerCursors"])
    expect(result.unknownFields).toEqual(["futureField"])
    expect(result.raw).toBe(raw)
  })

  it.each(["{broken", "null", "[]", "42", '{"version":1,"values":null}'])(
    "safely preserves invalid input %s",
    (raw) => {
      const result = parsePersonalPreferences(raw)
      expect(result.status).toBe("invalid")
      expect(result.preferences).toEqual(defaultPersonalPreferences)
      expect(result.raw).toBe(raw)
    }
  )

  it("does not reinterpret a future version as a current record", () => {
    const raw = '{"version":2,"values":{"interfaceTheme":"dark"}}'
    expect(parsePersonalPreferences(raw)).toMatchObject({
      status: "unsupported",
      raw,
      preferences: defaultPersonalPreferences,
    })
  })

  it("returns independent default objects", () => {
    const first = parsePersonalPreferences(null).preferences
    first.fontSize = "large"
    expect(parsePersonalPreferences(null).preferences.fontSize).toBe("default")
  })

  it("rejects protected/unknown fields in an outbound patch", () => {
    expect(
      personalPreferencePatchSchema.safeParse({ interfaceTheme: "dark" })
        .success
    ).toBe(true)
    for (const key of [
      "userId",
      "workspaceId",
      "role",
      "notificationPermission",
      "__proto__",
    ]) {
      expect(
        personalPreferencePatchSchema.safeParse(
          JSON.parse(`{"${key}":"admin"}`)
        ).success
      ).toBe(false)
    }
  })

  it("classifies appearance as account choices without persisting OS facts", () => {
    for (const key of Object.keys(defaultPersonalPreferences)) {
      expect(
        personalPreferenceScopes[key as keyof typeof personalPreferenceScopes]
      ).toBe("account")
    }
    expect(Object.keys(personalPreferenceScopes)).not.toContain(
      "notificationPermission"
    )
  })

  it("isolates scope kinds and delimiter-containing identifiers", () => {
    const keys = [
      preferenceCacheKey({ kind: "account", userId: "a" }),
      preferenceCacheKey({ kind: "account", userId: "b" }),
      preferenceCacheKey({ kind: "workspace", userId: "a", workspaceId: "b" }),
      preferenceCacheKey({ kind: "device", userId: "a", deviceId: "b" }),
      preferenceCacheKey({
        kind: "workspace",
        userId: "a:b",
        workspaceId: "c",
      }),
      preferenceCacheKey({
        kind: "workspace",
        userId: "a",
        workspaceId: "b:c",
      }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    expect(() => preferenceCacheKey({ kind: "account", userId: " " })).toThrow()
  })
})
