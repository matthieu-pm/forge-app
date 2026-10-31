import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  commentFromText,
  commentMentionIds,
  commentPlainText,
  resolveCommentMentions,
  safeCommentLink,
  validateCommentDocument,
} from "./comment-rich-text"
import { SafeCommentContent } from "@/components/issues/safe-comment-content"
import {
  filterIssueCopy,
  issueCopyIds,
} from "@/application/product-state/issue-copies"

describe("FOR-46 rich text trust boundary", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:alert(1)",
    "//evil.test",
    "/private-route",
    "https://user:pass@host.test",
    "java\nscript:alert(1)",
    "file:///etc/passwd",
  ])("rejects unsafe navigation %s", (href) => {
    expect(safeCommentLink(href)).toBe(false)
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Click",
              marks: [{ type: "link", attrs: { href } }],
            },
          ],
        },
      ],
    }
    expect(() => validateCommentDocument(doc)).toThrow()
  })
  it.each([
    { type: "script", text: "alert(1)" },
    { type: "image", attrs: { src: "https://private.test/pixel" } },
    {
      type: "paragraph",
      attrs: { onclick: "alert(1)" },
      content: [{ type: "text", text: "Click" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Click",
          marks: [{ type: "bold", attrs: { onmouseover: "alert(1)" } }],
        },
      ],
    },
  ])("safely renders malicious stored node as literal fallback", (node) => {
    const document = { type: "doc", content: [node] }
    expect(() => validateCommentDocument(document)).toThrow()
    const { container } = render(
      <SafeCommentContent
        document={document}
        fallback={'<img src=x onerror="alert(1)">'}
      />
    )
    expect(
      container.querySelector("script,img,a,[onclick],[onmouseover]")
    ).toBeNull()
    expect(container.textContent).toContain("<img")
  })
  it("renders only closed tags/attributes and resolves mention labels from server data", () => {
    const doc = validateCommentDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Read",
              marks: [
                { type: "bold" },
                {
                  type: "link",
                  attrs: {
                    href: "https://example.test",
                    target: "opener",
                    rel: "opener",
                  },
                },
              ],
            },
            { type: "mention", attrs: { id: "bob", label: "Fake Admin" } },
          ],
        },
      ],
    })
    const resolved = resolveCommentMentions(doc, new Map([["bob", "Bob"]]))
    expect(commentMentionIds(resolved)).toEqual(["bob"])
    expect(commentPlainText(resolved)).toBe("Read@Bob")
    const { container } = render(
      <SafeCommentContent document={resolved} fallback="" />
    )
    expect(screen.getByRole("link", { name: "Read" }).getAttribute("rel")).toBe(
      "noopener noreferrer nofollow"
    )
    expect(container.querySelector("strong")).not.toBeNull()
    expect(container.textContent).toBe("Read@Bob")
  })
  it("bounds recursion, text size, node count and rejects empty comments", () => {
    expect(() => validateCommentDocument(commentFromText(""))).toThrow()
    expect(() =>
      validateCommentDocument(commentFromText("a".repeat(10001)))
    ).toThrow()
    let doc: unknown = {
      type: "paragraph",
      content: [{ type: "text", text: "x" }],
    }
    for (let i = 0; i < 14; i++) doc = { type: "blockquote", content: [doc] }
    expect(() =>
      validateCommentDocument({ type: "doc", content: [doc] })
    ).toThrow()
    expect(() =>
      validateCommentDocument({
        type: "doc",
        content: Array.from({ length: 2001 }, () => ({ type: "paragraph" })),
      })
    ).toThrow()
  })
  it("filters and purges saved drafts as issue copies", () => {
    const issueId = "0a15da59-fd08-45b3-9709-b707d65654c2",
      key = `forge:comment-draft:v1:${issueId}:root`
    const raw = JSON.stringify({
      issueId,
      document: commentFromText("Private saved draft"),
    })
    expect(issueCopyIds(key, raw)).toEqual([issueId])
    expect(filterIssueCopy(key, raw, () => false)).toBeNull()
    expect(filterIssueCopy(key, raw, () => true)).toBe(raw)
  })
})
