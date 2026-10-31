import { z } from "zod"

export type CommentNode = {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  content?: Array<CommentNode>
}

export function safeCommentLink(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /\s/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return false
  try {
    const url = new URL(value)
    return (
      ["https:", "http:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}
const inline = new Set(["text", "hardBreak", "mention"])
const blocks = new Set([
  "paragraph",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
])

/** Closed JSON vocabulary: no HTML, arbitrary attributes, embeds or remote assets. */
export function validateCommentDocument(value: unknown): CommentNode {
  let count = 0,
    length = 0
  function visit(raw: unknown, depth: number, parent: string): CommentNode {
    if (
      ++count > 2000 ||
      depth > 12 ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    )
      throw new Error("Unsupported comment content.")
    const n = raw as CommentNode
    if (
      Object.keys(n).some(
        (k) => !["type", "text", "attrs", "marks", "content"].includes(k)
      )
    )
      throw new Error("Unsupported comment attributes.")
    if (typeof n.type !== "string") throw new Error("Unsupported comment node.")
    const isInline = inline.has(n.type)
    if (
      parent === "root"
        ? n.type !== "doc"
        : parent === "paragraph"
          ? !isInline
          : parent === "codeBlock"
            ? n.type !== "text"
            : ["bulletList", "orderedList"].includes(parent)
              ? n.type !== "listItem"
              : !blocks.has(n.type)
    )
      throw new Error("Unsupported comment structure.")
    const result: CommentNode = { type: n.type }
    if (n.type === "text") {
      if (typeof n.text !== "string" || !n.text || n.content || n.attrs)
        throw new Error("Invalid comment text.")
      length += n.text.length
      result.text = n.text
      if (n.marks) {
        if (!Array.isArray(n.marks) || n.marks.length > 5)
          throw new Error("Unsupported comment formatting.")
        result.marks = n.marks.map((mark) => {
          if (
            !mark ||
            Object.keys(mark).some((k) => !["type", "attrs"].includes(k))
          )
            throw new Error("Unsupported comment formatting.")
          if (mark.type === "link") {
            if (
              !mark.attrs ||
              Object.keys(mark.attrs).some(
                (k) => !["href", "target", "rel", "class"].includes(k)
              ) ||
              !safeCommentLink(mark.attrs.href)
            )
              throw new Error("Use a safe http, https or mailto link.")
            return { type: "link", attrs: { href: mark.attrs.href } }
          }
          if (
            !["bold", "italic", "strike", "code"].includes(mark.type) ||
            mark.attrs
          )
            throw new Error("Unsupported comment formatting.")
          return { type: mark.type }
        })
      }
    } else if (n.type === "mention") {
      if (
        !n.attrs ||
        Object.keys(n.attrs).some((k) => !["id", "label"].includes(k)) ||
        typeof n.attrs.id !== "string" ||
        !n.attrs.id ||
        n.attrs.id.length > 200 ||
        typeof n.attrs.label !== "string" ||
        n.attrs.label.length > 200 ||
        n.text ||
        n.content ||
        n.marks
      )
        throw new Error("Invalid mention.")
      result.attrs = { id: n.attrs.id, label: n.attrs.label }
      length += n.attrs.label.length + 1
    } else {
      if (n.text || n.marks) throw new Error("Unsupported comment attributes.")
      if (n.attrs && Object.keys(n.attrs).length) {
        if (
          n.type === "orderedList" &&
          Object.keys(n.attrs).every((k) => k === "start") &&
          Number.isInteger(n.attrs.start) &&
          Number(n.attrs.start) > 0 &&
          Number(n.attrs.start) < 10000
        )
          result.attrs = { start: n.attrs.start }
        else if (!(
          n.type === "codeBlock" &&
          Object.keys(n.attrs).every((k) => k === "language") &&
          n.attrs.language === null
        ))
          throw new Error("Unsupported comment attributes.")
      }
      if (n.type === "hardBreak") {
        if (n.content) throw new Error("Invalid line break.")
      } else {
        if (n.content !== undefined && !Array.isArray(n.content))
          throw new Error("Invalid comment content.")
        result.content = (n.content ?? []).map((child) =>
          visit(child, depth + 1, n.type)
        )
      }
    }
    if (length > 10000)
      throw new Error("Comments can contain up to 10,000 characters.")
    return result
  }
  const doc = visit(value, 0, "root")
  const plain = commentPlainText(doc)
  if (plain.length > 10000)
    throw new Error("Comments can contain up to 10,000 characters.")
  if (!plain.trim()) throw new Error("Write a comment before submitting.")
  return doc
}
export const commentDocumentSchema = z.unknown().transform((value, ctx) => {
  try {
    return validateCommentDocument(value)
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid comment.",
    })
    return z.NEVER
  }
})
export function commentPlainText(node: CommentNode): string {
  if (node.type === "text") return node.text ?? ""
  if (node.type === "mention") return `@${String(node.attrs?.label ?? "")}`
  if (node.type === "hardBreak") return "\n"
  return (node.content ?? [])
    .map(commentPlainText)
    .join(
      ["doc", "bulletList", "orderedList", "blockquote", "listItem"].includes(
        node.type
      )
        ? "\n"
        : ""
    )
}
export function commentFromText(text: string): CommentNode {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  }
}
export function commentMentionIds(doc: CommentNode): Array<string> {
  return [
    ...new Set(
      doc.type === "mention"
        ? [String(doc.attrs?.id)]
        : (doc.content ?? []).flatMap(commentMentionIds)
    ),
  ]
}
export function resolveCommentMentions(
  doc: CommentNode,
  people: Map<string, string>
): CommentNode {
  return {
    ...doc,
    ...(doc.type === "mention"
      ? {
          attrs: {
            id: doc.attrs!.id,
            label: people.get(String(doc.attrs!.id)) ?? "Member",
          },
        }
      : {}),
    ...(doc.content
      ? { content: doc.content.map((n) => resolveCommentMentions(n, people)) }
      : {}),
  }
}
