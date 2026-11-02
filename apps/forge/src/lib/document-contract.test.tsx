import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { documentBodySchema, parseDocumentBody } from "./document-contract"
import { DocumentContent } from "@/components/documents/document-content"

vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: ({ value }: { value: unknown }) => (
    <div data-testid="editor">{JSON.stringify(value)}</div>
  ),
}))
vi.mock("@/components/team-icon-picker", () => ({ TeamIconPicker: () => null }))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
const text = (marks?: unknown) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Recoverable text", ...(marks ? { marks } : {}) },
      ],
    },
  ],
})
describe("FOR-61 safe shared document content", () => {
  it("preserves supported formatting and reduces safe links to trusted attributes", () => {
    const body = parseDocumentBody(
      text([
        { type: "bold" },
        { type: "underline" },
        {
          type: "link",
          attrs: {
            href: "https://example.com",
            target: "_self",
            rel: "opener",
            class: "style",
          },
        },
      ])
    )
    expect(body.content?.[0].content?.[0].marks).toEqual([
      { type: "bold" },
      { type: "underline" },
      {
        type: "link",
        attrs: {
          href: "https://example.com",
          target: "_blank",
          rel: "noopener noreferrer",
        },
      },
    ])
  })
  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,WA==",
    "https://user:password@example.com",
    "https://example.com\n",
    "file:///etc/passwd",
  ])(
    "rejects executable or untrusted link %s without mutating the original",
    (href) => {
      const raw = text([{ type: "link", attrs: { href } }]),
        original = JSON.stringify(raw)
      expect(documentBodySchema.safeParse(raw).success).toBe(false)
      expect(JSON.stringify(raw)).toBe(original)
    }
  )
  it("rejects event attrs, arbitrary styles, unsafe embeds and invalid tree shapes", () => {
    for (const body of [
      {
        type: "doc",
        content: [{ type: "paragraph", attrs: { onclick: "alert(1)" } }],
      },
      {
        type: "doc",
        content: [{ type: "iframe", attrs: { src: "https://example.com" } }],
      },
      {
        type: "doc",
        content: [
          { type: "image", attrs: { src: "data:image/svg+xml;base64,WA==" } },
        ],
      },
      { type: "doc", content: [{ type: "text", text: "outside paragraph" }] },
      text([{ type: "bold", attrs: { style: "color:red" } }]),
    ])
      expect(documentBodySchema.safeParse(body).success).toBe(false)
  })
  it("bounds depth and size", () => {
    let body: unknown = { type: "paragraph" }
    for (let i = 0; i < 70; i++) body = { type: "blockquote", content: [body] }
    expect(
      documentBodySchema.safeParse({ type: "doc", content: [body] }).success
    ).toBe(false)
    expect(
      documentBodySchema.safeParse(
        text().content.map(() => "x".repeat(1000001))
      ).success
    ).toBe(false)
  })
  it("AT-03 renderer never hands unsafe persisted/imported JSON to Tiptap", () => {
    const body = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { onmouseover: "window.pwned=1" } },
      ],
    }
    render(
      <DocumentContent
        title="Unsafe import"
        body={body}
        icon={{ kind: "emoji", value: "🔥", color: "#123456" }}
        onTitleChange={() => {}}
        onBodyChange={() => {}}
        onIconChange={() => {}}
      />
    )
    expect(screen.queryByTestId("editor")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(JSON.stringify(body)).toContain("onmouseover")
  })
})
