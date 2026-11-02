import { describe, expect, it } from "vitest"
import {
  teamResourceFieldsSchema,
  teamResourceUrl,
} from "./team-resources-contract"

const id = "ccf1441f-15df-44b9-ac4b-09440dd1f00a"
describe("shared team resource validation", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///tmp/private",
    "mailto:person@example.com",
    "https://user:secret@example.com",
    "http://example.com/\npath",
    "https://example.com/\u0000path",
    "/relative",
    "//example.com",
  ])("rejects unsafe navigation %s", (value) =>
    expect(teamResourceUrl(value)).toBeNull()
  )
  it("normalizes HTTP(S) destinations", () => {
    expect(teamResourceUrl(" https://EXAMPLE.com/path ")).toBe(
      "https://example.com/path"
    )
    expect(teamResourceUrl("http://localhost:3000/overview")).toBe(
      "http://localhost:3000/overview"
    )
  })
  it("rejects executable destinations through the server command shape", () => {
    expect(() =>
      teamResourceFieldsSchema.parse({
        sections: [],
        links: [
          { id, title: "Attack", url: "javascript:alert(1)", sectionId: null },
        ],
        order: [],
      })
    ).toThrow()
  })
  it("rejects orphan links, duplicate section/link identities and duplicate ordering", () => {
    const section = { id, name: "Documents" },
      link = { id, title: "Guide", url: "https://example.com", sectionId: id }
    expect(() =>
      teamResourceFieldsSchema.parse({ sections: [], links: [link], order: [] })
    ).toThrow()
    expect(() =>
      teamResourceFieldsSchema.parse({
        sections: [section, section],
        links: [],
        order: [],
      })
    ).toThrow()
    expect(() =>
      teamResourceFieldsSchema.parse({
        sections: [section],
        links: [link, link],
        order: [],
      })
    ).toThrow()
    expect(() =>
      teamResourceFieldsSchema.parse({
        sections: [section],
        links: [link],
        order: [`link:${id}`, `link:${id}`],
      })
    ).toThrow()
  })
  it("bounds shared board size", () => {
    expect(() =>
      teamResourceFieldsSchema.parse({
        sections: Array.from({ length: 101 }, () => ({
          id: crypto.randomUUID(),
          name: "Section",
        })),
        links: [],
        order: [],
      })
    ).toThrow()
  })
})
