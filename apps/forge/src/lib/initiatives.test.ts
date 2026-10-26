import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  addInitiative,
  blankInitiative,
  contributingTeamIds,
  defaultInitiativePreferences,
  emptyInitiativeFilters,
  emptyInitiatives,
  initiativeHealth,
  initiativeMatches,
  initiativePreferencesKey,
  initiativeStoreSchema,
  initiativesSettingsStorageKey,
  initiativesStorageKey,
  patchInitiative,
  targetLabel,
  targetTimestamp,
  validInitiativeTarget,
  visibleInitiatives,
} from "./initiatives"
import { useInitiatives } from "./initiatives-state"
import type { Initiative, InitiativeFilter } from "./initiatives"

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const item = (patch: Partial<Initiative> = {}): Initiative => ({
  ...blankInitiative("creator"),
  name: "Launch",
  number: 1,
  ...patch,
})
const rule = (
  field: InitiativeFilter["field"],
  value: string,
  operator: InitiativeFilter["operator"] = "is"
): InitiativeFilter => ({ id: field, field, value, operator })

describe("initiative records and views", () => {
  it("allocates stable sequence numbers without reusing the last deleted initiative number", () => {
    const first = addInitiative(emptyInitiatives(), {
      ...blankInitiative("creator"),
      name: "First",
    })
    const second = addInitiative(
      { ...first, initiatives: [] },
      { ...blankInitiative("creator"), name: "Second" }
    )
    expect(second.initiatives[0].number).toBe(2)
    expect(second.nextNumber).toBe(3)
    const restored = initiativeStoreSchema.parse({
      version: 1,
      initiatives: [item({ number: 7 })],
    })
    expect(
      addInitiative(restored, { ...blankInitiative("creator"), name: "Next" })
        .initiatives[1].number
    ).toBe(8)
  })
  it("preserves identity and creation metadata when editing and records completion transitions", () => {
    const original = item()
    const completed = patchInitiative(
      original,
      { status: "Completed", id: "other", number: 99, creatorId: "other" },
      "2026-10-26T18:00:00Z"
    )
    expect(completed).toMatchObject({
      id: original.id,
      number: original.number,
      creatorId: original.creatorId,
      createdAt: original.createdAt,
      completedAt: "2026-10-26T18:00:00Z",
    })
    expect(patchInitiative(completed, { name: "Renamed" }).completedAt).toBe(
      completed.completedAt
    )
    expect(
      patchInitiative(completed, { status: "Active" }).completedAt
    ).toBeNull()
  })
  it("keeps active and proposed/planned scopes separate while All includes completed work", () => {
    const records = [
      item({ id: "active" }),
      item({ id: "planned", status: "Planned" }),
      item({ id: "proposed", status: "Proposed" }),
      item({ id: "done", status: "Completed" }),
    ]
    const view = (scope: "active" | "planned" | "all") =>
      visibleInitiatives(
        records,
        scope,
        emptyInitiativeFilters(),
        defaultInitiativePreferences(),
        []
      ).map((value) => value.id)
    expect(view("active")).toEqual(["active"])
    expect(view("planned")).toEqual(["planned", "proposed"])
    expect(view("all")).toHaveLength(4)
  })
  it("matches AND/OR conditions, owner absence, teams and quarter targets", () => {
    const record = item({
      priority: "High",
      targetDate: "2027-Q2",
      teamIds: ["team"],
    })
    expect(
      initiativeMatches(record, {
        match: "all",
        rules: [
          rule("Priority", "High"),
          rule("Owner", "", "is not set"),
          rule("Target date", "2027-07-01", "before"),
        ],
      })
    ).toBe(true)
    expect(
      initiativeMatches(record, {
        match: "all",
        rules: [rule("Priority", "Low"), rule("Contributing teams", "team")],
      })
    ).toBe(false)
    expect(
      initiativeMatches(record, {
        match: "any",
        rules: [rule("Priority", "Low"), rule("Contributing teams", "team")],
      })
    ).toBe(true)
    expect(
      initiativeMatches(item(), {
        match: "all",
        rules: [rule("Target date", "2027-01-01", "before")],
      })
    ).toBe(false)
  })
  it("sorts priority without treating no priority as urgent and leaves manual order intact", () => {
    const records = [
      item({ id: "none" }),
      item({ id: "low", priority: "Low" }),
      item({ id: "urgent", priority: "Urgent" }),
    ]
    expect(
      visibleInitiatives(
        records,
        "all",
        emptyInitiativeFilters(),
        { ...defaultInitiativePreferences(), ordering: "Priority" },
        []
      ).map((value) => value.id)
    ).toEqual(["urgent", "low", "none"])
    expect(
      visibleInitiatives(
        records,
        "all",
        emptyInitiativeFilters(),
        defaultInitiativePreferences(),
        []
      ).map((value) => value.id)
    ).toEqual(["none", "low", "urgent"])
    expect(records.map((value) => value.id)).toEqual(["none", "low", "urgent"])
  })
  it("validates dates and quarters and sorts periods by their actual final day", () => {
    expect(targetLabel("2027-Q2")).toBe("Q2 2027")
    expect(targetTimestamp("2027-Q2")).toBe(Date.UTC(2027, 5, 30, 23, 59, 59))
    expect(targetTimestamp("2028-02")).toBe(Date.UTC(2028, 1, 29, 23, 59, 59))
    for (const value of ["2027-02-29", "2027-13-01", "2027-Q5", "tomorrow"])
      expect(validInitiativeTarget(value)).toBe(false)
    for (const value of ["", "2027", "2027-02", "2028-02-29", "2027-Q4"])
      expect(validInitiativeTarget(value)).toBe(true)
  })
  it("derives health from the latest update and respects the workspace update schedule", () => {
    const record = item({
      updates: [
        {
          id: "update",
          text: "Progress",
          attachments: [],
          reactions: [],
          comments: [],
          health: "At risk",
          authorId: "creator",
          createdAt: "2026-10-01T12:00:00Z",
        },
      ],
    })
    expect(initiativeHealth(item())).toBe("Update missing")
    expect(
      initiativeHealth(record, "none", Date.parse("2026-10-26T12:00:00Z"))
    ).toBe("At risk")
    expect(
      initiativeHealth(record, "1-week", Date.parse("2026-10-26T12:00:00Z"))
    ).toBe("Update missing")
    expect(
      contributingTeamIds(
        item({
          teamIds: ["one"],
          projects: [
            {
              id: "project",
              name: "Work",
              status: "Active",
              teamIds: ["one", "two"],
              health: "On track",
            },
          ],
        })
      )
    ).toEqual(["one", "two"])
  })
})

describe("initiative persistence", () => {
  it("synchronizes mounted views, isolates workspaces, and stores display preferences per user", () => {
    const first = renderHook(() => useInitiatives("workspace", "user"))
    const second = renderHook(() => useInitiatives("workspace", "another"))
    const other = renderHook(() => useInitiatives("other-workspace", "user"))
    act(() => {
      expect(
        first.result.current.update((current) =>
          addInitiative(current, { ...blankInitiative("user"), name: "Saved" })
        )
      ).toBe(true)
    })
    expect(second.result.current.state.initiatives[0].name).toBe("Saved")
    expect(other.result.current.state.initiatives).toEqual([])
    act(() => {
      first.result.current.savePreferences({
        ...defaultInitiativePreferences(),
        sidebar: true,
        sidebarTab: "Health",
      })
    })
    expect(first.result.current.preferences.sidebar).toBe(true)
    expect(second.result.current.preferences.sidebar).toBe(false)
    expect(
      localStorage.getItem(initiativePreferencesKey("workspace", "user"))
    ).toContain("Health")
    first.unmount()
    const restored = renderHook(() => useInitiatives("workspace", "user"))
    expect(restored.result.current.state.initiatives[0].name).toBe("Saved")
    expect(restored.result.current.preferences.sidebar).toBe(true)
  })
  it("preserves damaged data, rejects writes, and does not replace it with defaults", () => {
    const key = initiativesStorageKey("workspace")
    localStorage.setItem(key, "damaged")
    const hook = renderHook(() => useInitiatives("workspace", "user"))
    expect(hook.result.current.error).toContain("preserved")
    expect(hook.result.current.update(() => emptyInitiatives())).toBe(false)
    expect(localStorage.getItem(key)).toBe("damaged")
  })
  it("keeps the previous records and reports failure when storage cannot be written", () => {
    const hook = renderHook(() => useInitiatives("workspace", "user"))
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    act(() => {
      expect(
        hook.result.current.update((current) =>
          addInitiative(current, {
            ...blankInitiative("user"),
            name: "Not saved",
          })
        )
      ).toBe(false)
    })
    expect(hook.result.current.state.initiatives).toEqual([])
  })
  it("honors disabled initiative settings without erasing existing records", () => {
    const state = addInitiative(emptyInitiatives(), {
      ...blankInitiative("user"),
      name: "Existing",
    })
    localStorage.setItem(
      initiativesStorageKey("workspace"),
      JSON.stringify(state)
    )
    localStorage.setItem(
      initiativesSettingsStorageKey("workspace"),
      JSON.stringify({ enabled: false, schedule: "2-weeks" })
    )
    const hook = renderHook(() => useInitiatives("workspace", "user"))
    expect(hook.result.current.writable).toBe(false)
    expect(hook.result.current.state.initiatives).toHaveLength(1)
    expect(hook.result.current.update(() => emptyInitiatives())).toBe(false)
    expect(
      JSON.parse(localStorage.getItem(initiativesStorageKey("workspace"))!)
        .initiatives
    ).toHaveLength(1)
  })
})
