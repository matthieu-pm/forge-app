import { z } from "zod"
import { safeCommentLink } from "./comment-rich-text"
import { documentChartSchema } from "./document-chart"
import type { JSONContent } from "@tiptap/core"

export const documentIconSchema = z
  .object({
    kind: z.enum(["icon", "emoji"]),
    value: z.string().min(1).max(100),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
  })
  .strict()
const empty = () => ({ type: "doc", content: [{ type: "paragraph" }] })
export const emptyDocumentBody = empty

/** A closed vocabulary shared by writes, imports and every document renderer. */
export function parseDocumentBody(raw: unknown): JSONContent {
  if (JSON.stringify(raw)?.length > 1_000_000)
    throw new Error("Document is too large.")
  let count = 0
  const blocks = new Set([
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "taskList",
    "blockquote",
    "codeBlock",
    "horizontalRule",
    "image",
    "details",
    "callout",
    "diagram",
    "analyticsChart",
  ])
  function visit(value: unknown, depth: number, parent: string): JSONContent {
    if (
      ++count > 10000 ||
      depth > 64 ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      throw new Error("Unsupported document structure.")
    const n = value as JSONContent
    if (
      Object.keys(n).some(
        (k) => !["type", "attrs", "text", "marks", "content"].includes(k)
      )
    )
      throw new Error("Unsupported document attributes.")
    const type = n.type ?? ""
    const allowed =
      parent === "root"
        ? type === "doc"
        : ["paragraph", "heading", "detailsSummary"].includes(parent)
          ? ["text", "hardBreak"].includes(type)
          : parent === "codeBlock"
            ? type === "text"
            : ["bulletList", "orderedList"].includes(parent)
              ? type === "listItem"
              : parent === "taskList"
                ? type === "taskItem"
                : parent === "details"
                  ? ["detailsSummary", "detailsContent"].includes(type)
                  : blocks.has(type)
    if (!allowed) throw new Error("Unsupported document node.")
    const result: JSONContent = { type }
    if (type === "text") {
      if (typeof n.text !== "string" || !n.text || n.attrs || n.content)
        throw new Error("Invalid document text.")
      result.text = n.text
    } else if (n.text !== undefined || n.marks !== undefined)
      throw new Error("Unsupported document formatting.")
    if (n.attrs !== undefined) {
      if (!n.attrs || typeof n.attrs !== "object" || Array.isArray(n.attrs))
        throw new Error("Invalid document attributes.")
      const schemas: Record<string, z.ZodType> = {
        heading: z.object({ level: z.number().int().min(1).max(3) }).strict(),
        orderedList: z
          .object({
            start: z.number().int().min(1).max(10000).optional(),
            type: z.null().optional(),
          })
          .strict(),
        taskItem: z.object({ checked: z.boolean() }).strict(),
        codeBlock: z
          .object({ language: z.string().max(100).nullable().optional() })
          .strict(),
        details: z.object({ open: z.boolean().optional() }).strict(),
        callout: z.object({ icon: documentIconSchema }).strict(),
        diagram: z.object({ source: z.string().max(50000) }).strict(),
        analyticsChart: z.object({ chart: documentChartSchema }).strict(),
        image: z
          .object({
            src: z
              .string()
              .max(800000)
              .refine(
                (v) =>
                  /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(
                    v
                  ) ||
                  (safeCommentLink(v) && /^https?:/.test(v))
              ),
            alt: z.string().max(1000).nullable().optional(),
            title: z.string().max(1000).nullable().optional(),
            width: z.number().positive().max(10000).nullable().optional(),
            height: z.number().positive().max(10000).nullable().optional(),
          })
          .strict(),
      }
      result.attrs = (schemas[type] ?? z.object({}).strict()).parse(
        n.attrs
      ) as Record<string, unknown>
    }
    if (n.marks !== undefined) {
      if (!Array.isArray(n.marks) || n.marks.length > 6)
        throw new Error("Unsupported document formatting.")
      result.marks = n.marks.map((m) => {
        if (!m || Object.keys(m).some((k) => !["type", "attrs"].includes(k)))
          throw new Error("Unsupported document formatting.")
        if (m.type === "link") {
          const attrs = z
            .object({
              href: z.string().refine(safeCommentLink),
              target: z.string().nullable().optional(),
              rel: z.string().nullable().optional(),
              class: z.string().nullable().optional(),
            })
            .strict()
            .parse(m.attrs)
          return {
            type: "link",
            attrs: {
              href: attrs.href,
              target: "_blank",
              rel: "noopener noreferrer",
            },
          }
        }
        if (
          !["bold", "italic", "underline", "strike", "code"].includes(m.type) ||
          m.attrs
        )
          throw new Error("Unsupported document formatting.")
        return { type: m.type }
      })
    }
    if (n.content !== undefined) {
      if (
        !Array.isArray(n.content) ||
        [
          "text",
          "hardBreak",
          "horizontalRule",
          "image",
          "diagram",
          "analyticsChart",
        ].includes(type)
      )
        throw new Error("Unsupported document structure.")
      result.content = n.content.map((child) => visit(child, depth + 1, type))
    }
    if (
      type === "details" &&
      (result.content?.length !== 2 ||
        result.content[0].type !== "detailsSummary" ||
        result.content[1].type !== "detailsContent")
    )
      throw new Error("Invalid collapsible section.")
    return result
  }
  return visit(raw, 0, "root")
}
export const documentBodySchema = z.unknown().transform((value, ctx) => {
  try {
    return parseDocumentBody(value)
  } catch {
    ctx.addIssue({
      code: "custom",
      message:
        "Unsupported or unsafe document content. Your draft has been preserved.",
    })
    return z.NEVER
  }
})
export const documentFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: documentBodySchema,
    icon: documentIconSchema,
    sectionId: z.string().max(200).nullable().default(null),
  })
  .strict()
export type DocumentFields = z.infer<typeof documentFieldsSchema>
export const documentSourceSchema = z
  .object({
    kind: z.enum(["workspace", "team", "project", "issue"]),
    id: z.uuid().optional(),
  })
  .strict()
  .refine((s) => (s.kind === "workspace" ? s.id === undefined : Boolean(s.id)))
export type DocumentSource = z.infer<typeof documentSourceSchema>
export const documentCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      legacyImport: z.literal(true).optional(),
      id: z.uuid(),
      source: documentSourceSchema,
      fields: documentFieldsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      id: z.uuid(),
      expectedRevision: z.number().int().nonnegative(),
      fields: documentFieldsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("restore"),
      id: z.uuid(),
      expectedRevision: z.number().int().nonnegative(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      id: z.uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("share"),
      id: z.uuid(),
      expectedRevision: z.number().int().nonnegative(),
      shared: z.boolean(),
    })
    .strict(),
])
export type DocumentCommand = z.infer<typeof documentCommandSchema>
export type SharedDocument = DocumentFields & {
  id: string
  revision: number
  content: string
  createdAt: string
  updatedAt: string
  owner: { id: string; name: string } | null
  updatedBy: { id: string; name: string } | null
  canDelete: boolean
  canShare: boolean
  sharedWithWorkspace: boolean
  unsafeBody?: boolean
}
export type DocumentRevision = DocumentFields & {
  revision: number
  createdAt: string
  author: { id: string; name: string } | null
  unsafeBody?: boolean
}
export type DocumentCommandResult =
  | { status: "saved"; id: string; revision: number }
  | { status: "conflict"; current: SharedDocument | null }
