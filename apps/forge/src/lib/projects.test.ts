import { describe, expect, it } from "vitest"
import { addInitiative, blankInitiative, emptyInitiatives } from "./initiatives"
import {
  defaultProjectPreferences,
  projectValues,
  saveWorkspaceProject,
  visibleProjects,
} from "./projects"
import { initiativeProjectCatalog } from "./initiative-projects"
import type { InitiativeProject } from "./initiatives"

const project: InitiativeProject = {
  id: "p",
  name: "Launch",
  status: "Backlog",
  health: "Update missing",
  teamIds: ["team"],
  priority: "High",
}
const prefs = defaultProjectPreferences()
describe("Workspace projects", () => {
  it("synchronizes projects across initiatives and detaches without deleting them", () => {
    let state = addInitiative(emptyInitiatives(), {
      ...blankInitiative("user"),
      id: "a",
      name: "A",
    })
    state = addInitiative(state, {
      ...blankInitiative("user"),
      id: "b",
      name: "B",
    })
    const first = "2026-10-26T10:00:00.000Z"
    state = saveWorkspaceProject(state, project, ["a", "b"], "user", first)
    expect(state.initiatives.map((item) => item.projects[0].name)).toEqual([
      "Launch",
      "Launch",
    ])
    state = saveWorkspaceProject(
      state,
      { ...project, name: "Launch v2" },
      ["b"],
      "other",
      "2026-10-26T11:00:00.000Z"
    )
    expect(state.initiatives[0].projects).toEqual([])
    expect(state.initiatives[1].projects[0].name).toBe("Launch v2")
    expect(initiativeProjectCatalog(state)).toHaveLength(1)
    expect(state.workspaceProjects[0]).toMatchObject({
      creatorId: "user",
      createdAt: first,
      updatedAt: "2026-10-26T11:00:00.000Z",
    })
    expect(projectValues(project, "Initiatives", state)).toEqual(["b"])
  })
  it("combines team, closed, text and property filters", () => {
    const projects = [
      project,
      { ...project, id: "closed", status: "Completed" as const },
      { ...project, id: "other", teamIds: ["other"] },
    ]
    expect(
      visibleProjects(
        projects,
        emptyInitiatives(),
        [
          { field: "Title & summary", value: "LAUNCH" },
          { field: "Priority", value: "High" },
        ],
        { ...prefs, closed: "Hide" },
        "team"
      ).map((item) => item.id)
    ).toEqual(["p"])
    expect(
      visibleProjects(projects, emptyInitiatives(), [], {
        ...prefs,
        closed: "Only",
      })
    ).toHaveLength(1)
  })
  it("sorts priority and partial dates without mutating the catalog", () => {
    const projects = [
      { ...project, id: "none", priority: "No priority" as const },
      { ...project, id: "later", targetDate: "2027-Q2" },
      {
        ...project,
        id: "early",
        priority: "Urgent" as const,
        targetDate: "2026-12",
      },
    ]
    expect(
      visibleProjects(projects, emptyInitiatives(), [], {
        ...prefs,
        ordering: "Priority",
      }).map((item) => item.id)
    ).toEqual(["early", "later", "none"])
    expect(
      visibleProjects(projects, emptyInitiatives(), [], {
        ...prefs,
        ordering: "Target date",
      }).map((item) => item.id)
    ).toEqual(["early", "later", "none"])
    expect(projects[0].id).toBe("none")
  })
})
