import { beforeEach, expect, it, vi } from "vitest"
import {
  currentProjectMilestone,
  matchesMilestone,
  milestoneProgress,
  relocateProjectMilestone,
} from "./project-milestones"
import {
  emptyInitiatives,
  initiativeProjectSchema,
  initiativesStorageKey,
} from "./initiatives"
import {
  blankIssueDraft,
  readIssueStore,
  saveTeamIssue,
  teamIssuesKey,
} from "./team-issues"
import type { InitiativeProject } from "./initiatives"
import { productStorage } from "@/lib/product-storage"

const first = {
  id: "m1",
  name: "Beta",
  completed: false,
  targetDate: "2026-11-13",
}
const second = { id: "m2", name: "Launch", completed: false }
const source: InitiativeProject = {
  id: "source",
  name: "Product",
  status: "Backlog",
  health: "Update missing",
  teamIds: ["team"],
  milestones: [first, second],
}
const target: InitiativeProject = {
  ...source,
  id: "target",
  name: "Next",
  milestones: [],
}
const key = initiativesStorageKey("workspace")
const read = () => JSON.parse(productStorage.getItem(key)!)
const relocate = (
  options: Partial<Parameters<typeof relocateProjectMilestone>[0]> = {}
) =>
  relocateProjectMilestone({
    workspaceId: "workspace",
    userId: "user",
    teamIds: ["team"],
    sourceId: "source",
    milestoneId: "m1",
    ...options,
  })
beforeEach(() => {
  vi.restoreAllMocks()
  productStorage.clear()
  productStorage.setItem(
    key,
    JSON.stringify({
      ...emptyInitiatives(),
      workspaceProjects: [source, target],
    })
  )
})

it("retains old milestones while validating the new metadata", () => {
  expect(
    initiativeProjectSchema.parse({
      ...source,
      milestones: [{ id: "old", name: "Old", completed: true }],
    }).milestones?.[0].completed
  ).toBe(true)
  expect(
    initiativeProjectSchema.safeParse({
      ...source,
      milestones: [{ ...first, targetDate: "wrong" }],
    }).success
  ).toBe(false)
})
it("keeps legacy name assignments after renaming and advances to the next unfinished milestone", () => {
  const issue = saveTeamIssue("team", {
    ...blankIssueDraft(),
    title: "Work",
    project: "source",
    milestone: "Beta",
  })
  const renamed = { ...first, name: "Private beta", aliases: ["Beta"] }
  expect(matchesMilestone(renamed, issue.milestone)).toBe(true)
  const rows = [{ issue, completed: true }]
  expect(milestoneProgress(renamed, rows)).toEqual({
    count: 1,
    completed: 1,
    percent: 100,
  })
  expect(
    currentProjectMilestone({ ...source, milestones: [renamed, second] }, rows)
      ?.id
  ).toBe("m2")
})
it("moves the milestone and its issues without changing other work", () => {
  saveTeamIssue("team", {
    ...blankIssueDraft(),
    title: "Beta work",
    project: "Product",
    milestone: "Beta",
  })
  saveTeamIssue("team", {
    ...blankIssueDraft(),
    title: "Launch work",
    project: "source",
    milestone: "m2",
  })
  relocate({ targetId: "target" })
  expect(
    read()
      .workspaceProjects.find((p: InitiativeProject) => p.id === "source")
      .milestones.map((m: { id: string }) => m.id)
  ).toEqual(["m2"])
  expect(
    read().workspaceProjects.find((p: InitiativeProject) => p.id === "target")
      .milestones[0].targetDate
  ).toBe("2026-11-13")
  expect(
    readIssueStore("team").issues.find((issue) => issue.title === "Beta work")
  ).toMatchObject({ project: "target", milestone: "m1" })
  expect(
    readIssueStore("team").issues.find((issue) => issue.title === "Launch work")
  ).toMatchObject({ project: "source", milestone: "m2" })
})
it("converts a milestone to a project with its date, description and issues", () => {
  saveTeamIssue("team", {
    ...blankIssueDraft(),
    title: "Beta work",
    project: "source",
    milestone: "m1",
  })
  const created = relocate({ convert: true })!
  expect(created).toMatchObject({
    name: "Beta",
    targetDate: "2026-11-13",
    milestones: [],
  })
  expect(
    read().workspaceProjects.some((p: InitiativeProject) => p.id === created.id)
  ).toBe(true)
  expect(readIssueStore("team").issues[0]).toMatchObject({
    project: created.id,
    milestone: "",
  })
})
it("deletes a milestone while retaining and unassigning its issues", () => {
  saveTeamIssue("team", {
    ...blankIssueDraft(),
    title: "Keep me",
    project: "source",
    milestone: "m1",
  })
  relocate()
  expect(readIssueStore("team").issues[0]).toMatchObject({
    project: "source",
    milestone: "",
    title: "Keep me",
  })
  expect(
    read().workspaceProjects.find(
      (project: InitiativeProject) => project.id === "source"
    ).milestones
  ).toHaveLength(1)
})
it("restores exact project and issue data if persisting a move fails", () => {
  saveTeamIssue("team", {
    ...blankIssueDraft(),
    title: "Keep me",
    project: "source",
    milestone: "m1",
  })
  const beforeProject = productStorage.getItem(key),
    beforeIssues = productStorage.getItem(teamIssuesKey("team"))
  const original = productStorage.setItem
  let failed = false
  vi.spyOn(productStorage, "setItem").mockImplementation(function (
    this: Storage,
    k,
    v
  ) {
    if (k === key && !failed) {
      failed = true
      throw new Error("Full")
    }
    original.call(this, k, v)
  })
  expect(() => relocate({ targetId: "target" })).toThrow("Full")
  expect(productStorage.getItem(key)).toBe(beforeProject)
  expect(productStorage.getItem(teamIssuesKey("team"))).toBe(beforeIssues)
})
