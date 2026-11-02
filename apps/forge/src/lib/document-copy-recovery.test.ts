import { describe, expect, it } from "vitest"
import {
  matchesReviewedLegacyDocument,
  retainCanonicalDocumentCopies,
  retainedDocumentTitle,
} from "./document-copy-recovery"
import { documentFieldsSchema } from "./document-contract"
import { defaultDocumentIcon } from "./team-documents"

const legacy = (id = "document", content = "Earlier writing") => ({
  id,
  kind: "document",
  title: "Plan",
  content,
  sectionId: null,
})
const snapshot = (
  resources: Array<unknown>,
  retainedDocumentDrafts?: Array<unknown>
) =>
  JSON.stringify({
    favorite: false,
    sections: [],
    loops: [],
    resources,
    ...(retainedDocumentDrafts ? { retainedDocumentDrafts } : {}),
  })
const fields = documentFieldsSchema.parse({
  title: "Plan",
  body: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Earlier writing" }],
      },
    ],
  },
  icon: defaultDocumentIcon,
  sectionId: null,
})
describe("FOR-61 legacy writing recovery", () => {
  it("matches exact normalized imported formatting and rejects a source changed after review", () => {
    expect(matchesReviewedLegacyDocument(legacy(), fields, "team")).toBe(true)
    expect(
      matchesReviewedLegacyDocument(
        { ...legacy(), body: fields.body, content: "Newer plain-text edit" },
        fields,
        "team"
      )
    ).toBe(false)
    expect(
      matchesReviewedLegacyDocument(
        legacy("document", "Newer writing"),
        fields,
        "team"
      )
    ).toBe(false)
    expect(
      matchesReviewedLegacyDocument(
        {
          ...legacy(),
          body: {
            type: "doc",
            content: [{ type: "paragraph", attrs: { onclick: "alert(1)" } }],
          },
        },
        fields,
        "team"
      )
    ).toBe(false)
    expect(
      matchesReviewedLegacyDocument(
        { id: "project-doc", title: "Plan", body: fields.body },
        fields,
        "project"
      )
    ).toBe(true)
  })
  it("moves canonical and deleted same-ID raw copies into recovery without interpreting unsafe JSON", () => {
    const raw = {
      ...legacy(),
      body: {
        type: "doc",
        content: [{ type: "script", text: "never execute" }],
      },
    }
    const next = JSON.parse(
      retainCanonicalDocumentCopies(
        snapshot([raw, legacy("other")]),
        null,
        new Set(["document"])
      )!
    )
    expect(next.resources).toEqual([legacy("other")])
    expect(next.retainedDocumentDrafts).toEqual([raw])
    expect(raw.body.content[0].type).toBe("script")
  })
  it("preserves stored drafts when an unrelated older client omits recovery fields and source copies", () => {
    const a = legacy("document", "Alice"),
      b = legacy("document", "Bob")
    const previous = snapshot([a], [b])
    const next = JSON.parse(
      retainCanonicalDocumentCopies(
        snapshot([]),
        previous,
        new Set(["document"])
      )!
    )
    expect(next.resources).toEqual([])
    expect(next.retainedDocumentDrafts).toEqual([b, a])
    const repeated = JSON.parse(
      retainCanonicalDocumentCopies(
        snapshot([]),
        JSON.stringify(next),
        new Set(["document"])
      )!
    )
    expect(repeated.retainedDocumentDrafts).toEqual([b, a])
  })
  it("retains originals when the generic key is removed without republishing canonical or deleted records", () => {
    const next = JSON.parse(
      retainCanonicalDocumentCopies(
        null,
        snapshot([legacy()]),
        new Set(["document"])
      )!
    )
    expect(next.resources).toEqual([])
    expect(next.retainedDocumentDrafts).toEqual([legacy()])
  })
  it("leaves ordinary non-document team content unchanged and gives raw copies safe display titles", () => {
    const value = snapshot([legacy("unpublished")])
    expect(retainCanonicalDocumentCopies(value, null, new Set())).toBe(value)
    expect(retainedDocumentTitle({ title: "<script>alert(1)</script>" })).toBe(
      "<script>alert(1)</script>"
    )
    expect(retainedDocumentTitle(null)).toBe("Recovered document draft")
  })
})
