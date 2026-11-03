import { describe, expect, it } from "vitest"
import { appNav, workspaceNav } from "./app-navigation"
import {
  accountPreferenceCommandSchema,
  decodeAccountPreferences,
} from "./account-preference-contract"
import {
  customizeSidebarItems,
  defaultSidebarLayout,
  reconcileSidebarLayout,
  sidebarDestinations,
  sidebarLayoutSchema,
} from "./sidebar-preference-contract"

describe("FOR-134 sidebar contract", () => {
  it("defines stable defaults for exactly the supported navigation candidates", () => {
    expect(
      customizeSidebarItems(appNav, "primary", defaultSidebarLayout).map(
        (item) => item.to
      )
    ).toEqual(appNav.filter((item) => !item.items).map((item) => item.to))
    expect(
      customizeSidebarItems(workspaceNav, "workspace", defaultSidebarLayout)
    ).toEqual(workspaceNav)
    expect(new Set(sidebarDestinations.map((item) => item.id)).size).toBe(
      sidebarDestinations.length
    )
  })

  it("reconciles retired, new, duplicate, required and unavailable IDs without mutating saved choices", () => {
    const saved = [
      { id: "retired", visible: true },
      { id: "reviews", visible: true },
      { id: "my-issues", visible: false },
      { id: "inbox", visible: false },
      { id: "inbox", visible: false },
    ]
    const original = structuredClone(saved)
    const result = reconcileSidebarLayout(
      saved,
      (item) => item.id !== "reviews"
    )
    expect(result.map((item) => item.id)).not.toContain("reviews")
    expect(result.map((item) => item.id)).not.toContain("retired")
    expect(result.filter((item) => item.id === "inbox")).toMatchObject([
      { visible: true },
    ])
    expect(result.find((item) => item.id === "my-issues")?.visible).toBe(false)
    expect(
      result.find((item) => item.id === "workspace-documents")?.visible
    ).toBe(true)
    expect(saved).toEqual(original)
  })

  it("cannot reintroduce a destination removed by the caller's access or feature policy", () => {
    const saved = [
      { id: "reviews", visible: true },
      { id: "workspace-members", visible: true },
      { id: "settings", visible: false },
    ]
    expect(customizeSidebarItems([{ to: "/inbox" }], "primary", saved)).toEqual(
      [{ to: "/inbox" }]
    )
    expect(customizeSidebarItems([], "workspace", saved)).toEqual([])
  })

  it("adds fields to version-1 snapshots independently and rejects malformed outbound lists", () => {
    expect(
      decodeAccountPreferences({ "general.fontSize": "large" }).general
    ).toMatchObject({
      fontSize: "large",
      sidebarLayout: defaultSidebarLayout,
      sidebarBadgeStyle: "count",
    })
    const valid = {
      sessionId: "session",
      expectedWorkspaceId: "workspace",
      commandKey: crypto.randomUUID(),
      version: 1,
      patch: {
        "general.sidebarLayout": defaultSidebarLayout,
        "general.sidebarBadgeStyle": "dot",
      },
      expectedVersions: {
        "general.sidebarLayout": 0,
        "general.sidebarBadgeStyle": 0,
      },
    }
    expect(accountPreferenceCommandSchema.safeParse(valid).success).toBe(true)
    for (const layout of [
      [
        { id: "inbox", visible: true },
        { id: "inbox", visible: false },
      ],
      [{ id: "/settings", visible: true }],
      [{ id: "inbox", visible: true, to: "/admin" }],
      Array.from({ length: 101 }, (_, i) => ({
        id: `item-${i}`,
        visible: true,
      })),
    ]) {
      expect(sidebarLayoutSchema.safeParse(layout).success).toBe(false)
      expect(
        accountPreferenceCommandSchema.safeParse({
          ...valid,
          patch: { ...valid.patch, "general.sidebarLayout": layout },
        }).success
      ).toBe(false)
    }
    expect(
      decodeAccountPreferences({
        "general.sidebarLayout": "bad",
        "general.sidebarBadgeStyle": "bad",
        "general.notificationBadge": "off",
      }).general
    ).toMatchObject({
      sidebarLayout: defaultSidebarLayout,
      sidebarBadgeStyle: "count",
      notificationBadge: "off",
    })
  })
})
