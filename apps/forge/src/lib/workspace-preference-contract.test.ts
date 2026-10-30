import { describe, expect, it } from "vitest"
import {
  accountPreferenceCommandSchema,
  flattenPreferences,
} from "./account-preference-contract"
import {
  decodeWorkspaceView,
  workspacePreferenceField,
  workspaceViewDefaults,
  workspaceViewPrefix,
} from "./workspace-preference-contract"
import type { WorkspaceViewKind } from "./workspace-preference-contract"

describe("workspace personal view contract", () => {
  it("every exposed view choice has a validated, independent leaf and stable default", () => {
    for (const kind of Object.keys(
      workspaceViewDefaults
    ) as Array<WorkspaceViewKind>) {
      const decoded = decodeWorkspaceView(kind, "main", {})
      const fields = flattenPreferences(decoded, workspaceViewPrefix(kind))
      expect(Object.keys(fields).length).toBeGreaterThan(0)
      for (const [key, value] of Object.entries(fields)) {
        expect(
          workspacePreferenceField(key)?.safeParse(value).success,
          key
        ).toBe(true)
        expect(
          accountPreferenceCommandSchema.safeParse({
            sessionId: "s",
            commandKey: crypto.randomUUID(),
            version: 1,
            scope: "workspace",
            patch: { [key]: value },
            expectedVersions: { [key]: 0 },
          }).success,
          key
        ).toBe(true)
      }
    }
  })
  it("does not treat unknown records or business fields as preferences", () => {
    for (const key of [
      "teamIssues.main.issues",
      "teamIssues.main.drafts",
      "teamHome.main.resources",
      "projects.main.role",
      "reviews.main.ownerId",
      "constructor.main.test",
      "general.interfaceTheme",
    ])
      expect(workspacePreferenceField(key)).toBeUndefined()
    expect(
      decodeWorkspaceView("inbox", "main", {
        "inbox.main.preferences.ordering": "oldest",
        "inbox.main.preferences.groupBy": "bad",
      }).preferences
    ).toMatchObject({ ordering: "oldest", groupBy: "none" })
  })
  it("encodes resource identifiers without collisions", () => {
    expect(workspaceViewPrefix("cycles", "a.b")).not.toBe(
      workspaceViewPrefix("cycles", "a%2Eb")
    )
  })
  it("rejects protected or unknown nested fields rather than accepting them as metadata", () => {
    const patch = {
      "teamIssues.main.filters.rules": [
        {
          id: "a",
          field: "content",
          operator: "contains",
          value: "test",
          ownerId: "other",
        },
      ],
    }
    expect(
      accountPreferenceCommandSchema.safeParse({
        sessionId: "s",
        commandKey: crypto.randomUUID(),
        version: 1,
        scope: "workspace",
        patch,
        expectedVersions: { "teamIssues.main.filters.rules": 0 },
      }).success
    ).toBe(false)
  })
})
