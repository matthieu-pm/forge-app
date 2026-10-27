import { describe, expect, it } from "vitest"
import {
  addInitiative,
  blankInitiative,
  emptyInitiatives,
  initiativeStoreSchema,
} from "./initiatives"
import {
  newResourceDocument,
  updateProjectResources,
} from "./project-resources"

describe("project resource persistence", () => {
  it("preserves document formatting, icon, timestamps, and favorite through serialization", () => {
    const document = {
      ...newResourceDocument(),
      favorite: true,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Release notes",
                marks: [{ type: "bold" }],
              },
            ],
          },
        ],
      },
    }
    const state = addInitiative(emptyInitiatives(), {
      ...blankInitiative("user"),
      name: "Launch",
      projects: [
        {
          id: "project",
          name: "Release",
          status: "Backlog",
          teamIds: [],
          health: "Update missing",
        },
      ],
    })
    const next = updateProjectResources(
      state,
      "project",
      () => [document],
      "user"
    )
    const saved = initiativeStoreSchema.parse(JSON.parse(JSON.stringify(next)))
    expect(saved.workspaceProjects[0].resources?.[0]).toEqual(document)
    expect(saved.initiatives[0].projects[0].resources?.[0]).toEqual(document)
  })
  it("merges resources against the latest project without losing unrelated edits", () => {
    const state = {
      ...emptyInitiatives(),
      workspaceProjects: [
        {
          id: "project",
          name: "New name",
          status: "Backlog" as const,
          teamIds: [],
          health: "Update missing" as const,
          resources: [
            { id: "existing", title: "Brief", url: "https://example.com" },
          ],
        },
      ],
    }
    const document = newResourceDocument()
    const next = updateProjectResources(
      state,
      "project",
      (resources) => [...resources, document],
      "user"
    )
    expect(next.workspaceProjects[0].name).toBe("New name")
    expect(next.workspaceProjects[0].resources).toHaveLength(2)
    expect(() =>
      updateProjectResources(state, "removed", () => [], "user")
    ).toThrow("Project removed")
  })
})
