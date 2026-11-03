// @vitest-environment node
import { describe, expect, it } from "vitest"
import { buildImportManifest } from "./manifest"
import { blankInitiative } from "@/lib/initiatives"
import { newCustomView } from "@/lib/custom-views"

const teamId = "a24827c5-4bba-4751-948e-4f59645154b8",
  workspaceId = "workspace",
  actorId = "alice"
const modules = {
  initiatives: true,
  documents: true,
  views: true,
  resources: true,
  milestones: true,
}
const make = (
  sources: Array<{ key: string; raw: string }>,
  enabled = modules
) =>
  buildImportManifest({
    id: crypto.randomUUID(),
    actorId,
    workspaceId,
    defaultStatus: "todo",
    sources,
    modules: enabled,
  })
const home = (resources: Array<unknown>) => ({
  key: `forge:team-home:v1:${teamId}`,
  raw: JSON.stringify({
    favorite: true,
    sections: [{ id: "section", name: "Notes", collapsed: true }],
    resources,
    loops: [],
  }),
})
const doc = (id: string, extra = {}) => ({
  id,
  kind: "document",
  title: id,
  content: "Retained text",
  sectionId: "section",
  updatedAt: new Date().toISOString(),
  favorite: true,
  ...extra,
})

describe("FOR-126 versioned content manifests", () => {
  it("AT-01 inventories enabled content with stable paths, relationships and exact original backup", () => {
    const initiative = {
      ...blankInitiative(actorId),
      number: 1,
      name: "Strategy",
      projects: [
        {
          id: "project",
          name: "Roadmap",
          status: "Active",
          health: "On track",
          teamIds: [teamId],
          milestones: [{ id: "milestone", name: "Launch", completed: false }],
          resources: [
            {
              id: "project-doc",
              title: "Design",
              body: { type: "doc", content: [{ type: "paragraph" }] },
            },
          ],
        },
      ],
    }
    const sources = [
      home([
        doc("note"),
        {
          id: "link",
          kind: "link",
          title: "Source",
          content: "https://example.com",
          sectionId: "section",
        },
      ]),
      {
        key: `forge:workspace:${workspaceId}:initiatives:v1`,
        raw: JSON.stringify({
          version: 1,
          initiatives: [initiative],
          workspaceProjects: [],
        }),
      },
      {
        key: `forge:workspace:${workspaceId}:custom-views:v1:${actorId}`,
        raw: JSON.stringify({
          version: 1,
          views: [newCustomView("issues", actorId)],
        }),
      },
    ]
    const first = make(sources),
      second = make([...sources].reverse())
    expect(first.contentVersion).toBe(2)
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.entries.map((e) => e.id)).toEqual(
      second.entries.map((e) => e.id)
    )
    expect(first.entries.every((e) => e.sourceValid)).toBe(true)
    expect(first.entries.map((e) => e.kind).sort()).toEqual([
      "document",
      "document",
      "initiative",
      "milestone",
      "project",
      "resource",
      "resource",
      "view",
    ])
    expect(
      first.entries.find((e) => e.kind === "milestone")?.content
    ).toMatchObject({ projectId: "project" })
    for (const source of sources)
      expect(first.sources.find((s) => s.key === source.key)?.raw).toBe(
        source.raw
      )
    expect(
      first.entries.find((e) => e.kind === "view")?.content
    ).not.toHaveProperty("favorite")
  })
  it("AT-02 quarantines invalid rich text and ambiguous sharing/ownership individually", () => {
    const views = [
      newCustomView("issues", actorId),
      { ...newCustomView("issues", "bob"), name: "Other account" },
      { ...newCustomView("issues", actorId), visibility: "unknown" },
    ]
    const source = home([
      doc("good"),
      doc("bad", {
        body: { type: "doc", content: [{ type: "script", text: "bad" }] },
      }),
    ])
    const result = make([
      source,
      {
        key: `forge:workspace:${workspaceId}:custom-views:v1:${actorId}`,
        raw: JSON.stringify({ version: 1, views }),
      },
    ])
    expect(
      result.entries.filter((e) => e.state === "quarantined")
    ).toHaveLength(3)
    expect(result.entries.find((e) => e.legacyId === "good")?.state).toBe(
      "pending"
    )
    expect(result.sources.find((s) => s.key === source.key)?.raw).toBe(
      source.raw
    )
  })
  it("keeps disabled slices, unrelated accounts and personal preference sources excluded", () => {
    const off = {
      initiatives: false,
      documents: false,
      views: false,
      resources: false,
      milestones: false,
    }
    const sources = [
      home([doc("note")]),
      {
        key: `forge:workspace:${workspaceId}:custom-views:v1:bob`,
        raw: JSON.stringify({
          version: 1,
          views: [newCustomView("issues", "bob")],
        }),
      },
      { key: "forge:preferences:v1:alice", raw: '{"theme":"dark"}' },
    ]
    expect(make(sources, off).entries).toEqual([])
    expect(make(sources, off).sources).toHaveLength(3)
    expect(make(sources).fingerprint).not.toBe(make(sources, off).fingerprint)
    expect(make(sources).entries.map((e) => e.kind)).toEqual([
      "resource",
      "document",
    ])
  })
  it("keeps the v1 core manifest contract when no content version is supplied", () => {
    const result = buildImportManifest({
      id: crypto.randomUUID(),
      actorId,
      workspaceId,
      defaultStatus: "todo",
      sources: [home([doc("note")])],
    })
    expect(result.contentVersion).toBeUndefined()
    expect(result.entries).toEqual([])
  })
  it("quarantines unsafe links while retaining unsupported initiative/project resource scopes", () => {
    const result = make([
      home([
        {
          id: "unsafe",
          kind: "link",
          title: "Bad",
          content: "javascript:alert(1)",
        },
      ]),
    ])
    expect(result.entries.find((e) => e.legacyId === "unsafe")).toMatchObject({
      state: "quarantined",
      sourceValid: false,
    })
  })
  it("rejects unrecognized filter fields and contradictory resource visibility instead of dropping intent", () => {
    const view = newCustomView("issues", actorId)
    const result = make([
      home([
        doc("private", { visibility: "personal" }),
        doc("workspace", { sharedWithWorkspace: true }),
      ]),
      {
        key: `forge:workspace:${workspaceId}:custom-views:v1:${actorId}`,
        raw: JSON.stringify({
          version: 1,
          views: [
            {
              ...view,
              filters: { ...view.filters, unknownScope: "restricted" },
            },
          ],
        }),
      },
    ])
    expect(
      result.entries.filter((e) => e.state === "quarantined")
    ).toHaveLength(3)
  })
  it("retains an explicitly future team-home schema without importing it", () => {
    const source = home([doc("future")])
    source.raw = JSON.stringify({ ...JSON.parse(source.raw), version: 99 })
    const result = make([source])
    expect(result.entries).toEqual([])
    expect(result.sourceErrors).toHaveLength(1)
    expect(result.sources[0].raw).toBe(source.raw)
  })
  it("stores the canonical rich-text normalization for initiatives and milestones", () => {
    const body = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Source",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com",
                    target: "_self",
                    rel: "opener",
                    class: "legacy",
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const initiative = {
      ...blankInitiative(actorId),
      number: 1,
      name: "Strategy",
      description: body,
      projects: [
        {
          id: "project",
          name: "Roadmap",
          status: "Active",
          health: "On track",
          teamIds: [teamId],
          milestones: [
            {
              id: "milestone",
              name: "Launch",
              completed: false,
              description: body,
            },
          ],
        },
      ],
    }
    const result = make([
      {
        key: `forge:workspace:${workspaceId}:initiatives:v1`,
        raw: JSON.stringify({
          version: 1,
          initiatives: [initiative],
          workspaceProjects: [],
        }),
      },
    ])
    const attrs = {
      href: "https://example.com",
      target: "_blank",
      rel: "noopener noreferrer",
    }
    for (const entry of result.entries)
      if (
        entry.content?.kind === "initiative" ||
        entry.content?.kind === "milestone"
      )
        expect(
          entry.content.fields.description?.content?.[0].content?.[0].marks?.[0]
            .attrs
        ).toEqual(attrs)
  })
})
