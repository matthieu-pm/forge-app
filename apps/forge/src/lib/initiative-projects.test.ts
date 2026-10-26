import { describe, expect, it } from "vitest"
import {
  addInitiative,
  blankInitiative,
  emptyInitiatives,
  initiativeSchema,
  initiativeStoreSchema,
} from "./initiatives"
import {
  initiativeProjectCatalog,
  projectDependencyCycle,
  saveInitiativeProject,
} from "./initiative-projects"
import type { InitiativeProject } from "./initiatives"

const project: InitiativeProject = {
  id: "project",
  name: "Release",
  status: "Active",
  teamIds: ["team"],
  health: "Update missing",
  priority: "High",
  milestones: [{ id: "milestone", name: "Ship", completed: false }],
}
const record = () =>
  initiativeSchema.parse({
    ...blankInitiative("user"),
    name: "Launch",
    number: 1,
    updates: [
      {
        id: "update",
        text: "Already shipped a milestone",
        health: "On track",
        authorId: "user",
        createdAt: new Date().toISOString(),
      },
    ],
    resources: [
      { id: "resource", title: "Brief", url: "https://example.com/brief" },
    ],
  })
describe("Initiative project catalog", () => {
  it("migrates existing initiatives and project snapshots without losing updates", () => {
    const legacy = record()
    const state = initiativeStoreSchema.parse({
      version: 1,
      initiatives: [{ ...legacy, projects: [project] }],
    })
    expect(state.workspaceProjects).toEqual([])
    expect(initiativeProjectCatalog(state)).toEqual([project])
    expect(state.initiatives[0].updates[0].comments).toEqual([])
  })
  it("creates and edits a shared project while preserving initiative updates, resources, and metadata", () => {
    let state = addInitiative(emptyInitiatives(), record())
    const first = state.initiatives[0]
    state = saveInitiativeProject(state, first.id, project)
    const second = {
      ...blankInitiative("user"),
      id: "other",
      name: "Second initiative",
      projects: [project],
    }
    state = addInitiative(state, second)
    state = saveInitiativeProject(state, first.id, {
      ...project,
      name: "Release v2",
      status: "Completed",
    })
    expect(state.initiatives.map((value) => value.projects[0].name)).toEqual([
      "Release v2",
      "Release v2",
    ])
    expect(state.initiatives[0].updates).toEqual(first.updates)
    expect(state.initiatives[0].resources).toEqual(first.resources)
    expect(state.initiatives[0].createdAt).toBe(first.createdAt)
    expect(initiativeProjectCatalog(state)).toHaveLength(1)
    expect(state.workspaceProjects[0].status).toBe("Completed")
  })
  it("detects direct and indirect dependency cycles without rejecting a shared dependency", () => {
    const a = { ...project, id: "a", dependencyIds: ["b"] }
    const b = { ...project, id: "b", dependencyIds: ["c"] }
    const c = { ...project, id: "c", dependencyIds: [] }
    expect(projectDependencyCycle(a, [b, c])).toBe(false)
    expect(projectDependencyCycle({ ...a, dependencyIds: ["a"] }, [])).toBe(
      true
    )
    expect(projectDependencyCycle({ ...c, dependencyIds: ["a"] }, [a, b])).toBe(
      true
    )
  })
})
