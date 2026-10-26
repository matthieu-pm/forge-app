import { describe, expect, it } from "vitest"
import {
  documentPlainText,
  newTeamDocument,
  teamDocumentBody,
} from "./team-documents"
import { emptyTeamHome, teamHomeSchema } from "./team-home-state"

describe("team document compatibility", () => {
  it("opens existing multiline content as text without interpreting HTML", () => {
    const resource = {
      id: "legacy",
      kind: "document" as const,
      title: "Existing notes",
      content: "First line\n\n<script>alert('text')</script>",
      sectionId: "section",
      updatedAt: "2026-10-12",
    }
    const saved = teamHomeSchema.parse({
      ...emptyTeamHome(),
      resources: [resource],
    }).resources[0]
    expect(documentPlainText(teamDocumentBody(saved))).toBe(resource.content)
    expect(saved.sectionId).toBe("section")
    expect(teamDocumentBody(saved).content?.at(-1)).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "<script>alert('text')</script>" }],
    })
  })

  it("preserves formatting while retaining a plain-text version for existing resource readers", () => {
    const body = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Plan" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Next steps", marks: [{ type: "bold" }] },
          ],
        },
      ],
    }
    const resource = {
      ...newTeamDocument({ id: "owner", name: "Owner" }, "notes"),
      body,
      content: documentPlainText(body),
    }
    const saved = teamHomeSchema.parse({
      ...emptyTeamHome(),
      resources: [resource],
    }).resources[0]
    expect(teamDocumentBody(saved)).toEqual(body)
    expect(saved.content).toBe("Plan\nNext steps")
    expect(saved.owner?.id).toBe("owner")
    expect(saved.createdAt).toBe(saved.updatedAt)
    expect(saved.sectionId).toBe("notes")
  })
})
