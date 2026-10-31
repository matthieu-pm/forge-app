// @vitest-environment node
import { describe, expect, it } from "vitest"
import { buildImportManifest, validatedImportFiles } from "./manifest"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const team = "a24827c5-4bba-4751-948e-4f59645154b8",
  workspaceId = "workspace"
const issue = (id: string, extra = {}) => ({
  ...blankIssueDraft("todo"),
  id,
  number: 1,
  title: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  statusChangedAt: "2026-01-01T00:00:00.000Z",
  creator: "historical-user",
  suggestedLabel: "",
  completedAt: null,
  recurrenceSpawned: false,
  ...extra,
})
const source = (issues: Array<unknown>) => ({
  key: `forge:team-issues:v1:${team}`,
  raw: JSON.stringify({ version: 1, issues }),
})
const manifest = (sources: Array<{ key: string; raw: string }>) =>
  buildImportManifest({
    id: crypto.randomUUID(),
    actorId: "alice",
    workspaceId,
    sources,
    defaultStatus: "todo",
  })
describe("FOR-56 trusted manifest parsing", () => {
  it("preserves both overlapping source versions instead of silently selecting one", () => {
    const a = source([issue("same")]),
      b = source([issue("same", { description: "changed" })])
    const result = manifest([a, b])
    expect(result.entries).toHaveLength(2)
    expect(new Set(result.entries.map((e) => e.id)).size).toBe(2)
    expect(new Set(result.entries.map((e) => e.fingerprint)).size).toBe(2)
    expect(result.sources.map((s) => s.raw)).toEqual([a.raw, b.raw])
  })
  it("quarantines one invalid record and retains valid siblings and exact raw bytes", () => {
    const original = source([issue("good"), { id: "bad", title: 42 }]),
      result = manifest([original])
    expect(result.entries.map((e) => e.state)).toEqual([
      "pending",
      "quarantined",
    ])
    expect(result.sources[0].raw).toBe(original.raw)
  })
  it("does not import future schemas, views, documents or absent fixtures", () => {
    const result = manifest([
      {
        key: `forge:team-issues:v1:${team}`,
        raw: '{"version":99,"issues":[]}',
      },
      { key: "forge:document:v1:one", raw: '{"secret":"retained"}' },
    ])
    expect(result.entries).toEqual([])
    expect(result.exclusions.join(" ")).toMatch(/Unsupported source schema/)
    expect(result.sources).toHaveLength(2)
    expect(manifest([]).entries).toEqual([])
  })
  it("verifies file bytes, declared checksum and declared size", () => {
    const file = {
      name: "evidence.txt",
      data: "data:text/plain;base64,aGVsbG8=",
    }
    expect(validatedImportFiles([file])[0]).toMatchObject({
      sizeBytes: 5,
      checksum:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    })
    expect(() =>
      validatedImportFiles([{ ...file, name: "../bad.txt" }])
    ).toThrow()
    expect(
      validatedImportFiles([{ ...file, name: " evidence.txt " }])[0].name
    ).toBe("evidence.txt")
    expect(() => validatedImportFiles([{ ...file, sizeBytes: 6 }])).toThrow(
      /size/
    )
    expect(() =>
      validatedImportFiles([{ ...file, checksum: "a".repeat(64) }])
    ).toThrow(/checksum/)
    expect(() =>
      validatedImportFiles([{ ...file, data: "data:text/plain;base64,a===" }])
    ).toThrow()
  })
  it("retains historical claims as source data without claiming them as authenticated authors", () => {
    const record = issue("history", {
      activity: [
        {
          id: "event",
          author: "historical-user",
          text: "old",
          createdAt: "2020-01-01",
        },
      ],
    })
    const result = manifest([source([record])])
    expect(result.entries[0].draft).not.toHaveProperty("creator")
    expect(result.entries[0].draft).not.toHaveProperty("createdAt")
    expect(result.entries[0].draft?.activity[0].author).toBe("historical-user")
    expect(result.exclusions.join(" ")).toContain("preserved privately")
  })
})
