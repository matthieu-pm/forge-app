import { describe, expect, it } from "vitest"
import { emptyTemplate, saveTemplateSchema } from "./template-contract"

const base = {
  ...emptyTemplate("document", "00000000-0000-4000-8000-000000000001"),
  name: "Brief",
}
function valid(node: unknown) {
  return saveTemplateSchema.safeParse({
    slug: "testing",
    payload: { ...base, content: { type: "doc", content: [node] } },
  }).success
}
describe("Template content validation", () => {
  it("rejects executable URLs and malformed callout icons", () => {
    expect(
      valid({ type: "image", attrs: { src: "javascript:alert(1)" } })
    ).toBe(false)
    expect(
      valid({
        type: "attachment",
        attrs: { src: "javascript:alert(1)", name: "File", mime: "text/plain" },
      })
    ).toBe(false)
    expect(valid({ type: "callout", attrs: { icon: "bad" } })).toBe(false)
    expect(
      valid({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "link",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      })
    ).toBe(false)
  })
  it("accepts uploaded images, files, and ordinary links", () => {
    expect(
      valid({ type: "image", attrs: { src: "data:image/png;base64,QQ==" } })
    ).toBe(true)
    expect(
      valid({
        type: "attachment",
        attrs: {
          src: "data:text/plain;base64,QQ==",
          name: "brief.txt",
          mime: "text/plain",
        },
      })
    ).toBe(true)
    expect(
      valid({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "link",
            marks: [{ type: "link", attrs: { href: "https://example.com" } }],
          },
        ],
      })
    ).toBe(true)
  })
  it("rejects excessive nesting and unsupported content nodes", () => {
    let node: unknown = { type: "paragraph" }
    for (let i = 0; i < 70; i++) node = { type: "blockquote", content: [node] }
    expect(valid(node)).toBe(false)
    expect(valid({ type: "script", content: [] })).toBe(false)
  })
})
