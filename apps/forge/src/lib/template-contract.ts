import { z } from "zod"
import type { JSONContent } from "@tiptap/core"
import type { TeamSummary } from "@/lib/team-contract"

export const templateKindSchema = z.enum(["issue", "project", "document"])
export type TemplateKind = z.infer<typeof templateKindSchema>
const iconSchema = z.object({
  kind: z.enum(["icon", "emoji"]),
  value: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
})
const nodeTypes = new Set([
  "doc",
  "paragraph",
  "text",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "blockquote",
  "codeBlock",
  "hardBreak",
  "horizontalRule",
  "image",
  "details",
  "detailsSummary",
  "detailsContent",
  "callout",
  "diagram",
  "attachment",
])
function validDocument(document: Record<string, unknown>) {
  if (document.type !== "doc") return false
  const pending: Array<{ node: unknown; depth: number }> = [
    { node: document, depth: 0 },
  ]
  let count = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (
      ++count > 10_000 ||
      entry.depth > 64 ||
      !entry.node ||
      typeof entry.node !== "object"
    )
      return false
    const node = entry.node as Record<string, unknown>
    if (typeof node.type !== "string" || !nodeTypes.has(node.type)) return false
    if (
      node.type === "text" &&
      (typeof node.text !== "string" || !node.text.length)
    )
      return false
    if (
      node.attrs !== undefined &&
      (!node.attrs ||
        typeof node.attrs !== "object" ||
        Array.isArray(node.attrs))
    )
      return false
    const attrs = (node.attrs ?? {}) as Record<string, unknown>
    if (node.type === "callout" && !iconSchema.safeParse(attrs.icon).success)
      return false
    if (node.type === "diagram" && typeof attrs.source !== "string")
      return false
    if (
      node.type === "image" &&
      (typeof attrs.src !== "string" ||
        !/^(https?:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/i.test(
          attrs.src
        ))
    )
      return false
    if (
      node.type === "attachment" &&
      (typeof attrs.src !== "string" ||
        !/^data:[a-z0-9.+/-]*;base64,[a-z0-9+/=]*$/i.test(attrs.src) ||
        typeof attrs.name !== "string" ||
        typeof attrs.mime !== "string")
    )
      return false
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return false
      for (const mark of node.marks) {
        if (
          !mark ||
          typeof mark !== "object" ||
          !["bold", "italic", "underline", "strike", "code", "link"].includes(
            mark.type
          )
        )
          return false
        if (
          mark.type === "link" &&
          (typeof mark.attrs?.href !== "string" ||
            !/^(https?:\/\/|mailto:)/i.test(mark.attrs.href))
        )
          return false
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return false
      for (const child of node.content)
        pending.push({ node: child, depth: entry.depth + 1 })
    }
  }
  return true
}
const documentSchema = z
  .record(z.string(), z.json())
  .refine(validDocument, "Invalid document content or attachment URL.")
  .nullable()
export const propertiesSchema = z.object({
  teamIds: z.array(z.string().uuid()).max(100),
  status: z.string().max(50),
  estimate: z.string().max(30).nullable().optional(),
  priority: z.enum(["No priority", "Urgent", "High", "Medium", "Low"]),
  assignee: z.string().nullable(),
  lead: z.string().nullable(),
  members: z.array(z.string()).max(100),
  project: z.string().max(200).nullable(),
  initiatives: z.array(z.string().max(200)).max(100),
  labels: z.array(z.string().max(200)).max(100),
  dependencies: z
    .array(
      z.object({
        direction: z.enum(["blockedBy", "blocking"]),
        name: z.string().trim().min(1).max(200),
      })
    )
    .max(100),
})
const itemSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(200),
  content: documentSchema,
  properties: propertiesSchema,
})
export const templatePayloadSchema = z.object({
  name: z.string().trim().min(1, "Give your template a name.").max(200),
  kind: templateKindSchema,
  icon: iconSchema,
  description: z.string().max(2000),
  title: z.string().max(200),
  summary: z.string().max(2000),
  content: documentSchema,
  properties: propertiesSchema,
  visibility: z.string(),
  milestones: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().trim().min(1).max(200),
        content: documentSchema,
      })
    )
    .max(100),
  issues: z.array(itemSchema).max(100),
  subIssues: z.array(itemSchema).max(100),
  issueType: z.enum(["standard", "form"]),
  fields: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().trim().min(1).max(200),
        type: z.enum([
          "text",
          "textarea",
          "select",
          "checkbox",
          "date",
          "number",
        ]),
        required: z.boolean(),
        options: z.array(z.string().max(200)).max(100),
      })
    )
    .max(100),
})
// JSON documents are rendered through the editor's node schema, never as arbitrary HTML.
export type TemplateProperties = z.infer<typeof propertiesSchema>
export type TemplateDraft = Omit<
  z.infer<typeof templatePayloadSchema>,
  "content" | "milestones" | "issues" | "subIssues"
> & {
  content: JSONContent | null
  milestones: Array<{ id: string; title: string; content: JSONContent | null }>
  issues: Array<TemplateItem>
  subIssues: Array<TemplateItem>
}
export type TemplateItem = {
  id: string
  title: string
  content: JSONContent | null
  properties: TemplateProperties
}
export type SavedTemplate = {
  id: string
  payload: TemplateDraft
  createdBy: string
  createdAt: string
  updatedAt: string
}
export type TemplateDirectory = {
  templates: Array<SavedTemplate>
  defaults: { members: string | null; nonMembers: string | null }
  teams: Array<TeamSummary>
  members: Array<{ id: string; name: string; image: string | null }>
  canManage: boolean
}
export const templateQuerySchema = z.object({
  slug: z.string().min(1).max(100),
})
export const templateScopeSchema = templateQuerySchema.partial()
export const saveTemplateSchema = templateScopeSchema
  .extend({
    id: z.string().uuid().optional(),
    updatedAt: z.string().optional(),
    payload: templatePayloadSchema,
  })
  .refine(
    (input) => JSON.stringify(input.payload).length <= 8_000_000,
    "Template content is too large. Use smaller attachments."
  )
export const deleteTemplateSchema = templateScopeSchema.extend({
  id: z.string().uuid(),
})
export const defaultTemplateSchema = templateQuerySchema.extend({
  audience: z.enum(["members", "nonMembers"]),
  templateId: z.string().uuid().nullable(),
})
export function emptyProperties(teamId?: string): TemplateProperties {
  return {
    teamIds: teamId ? [teamId] : [],
    status: "Backlog",
    priority: "No priority",
    assignee: null,
    lead: null,
    members: [],
    project: null,
    initiatives: [],
    labels: [],
    dependencies: [],
  }
}
export function emptyTemplate(
  kind: TemplateKind,
  teamId?: string
): TemplateDraft {
  return {
    name: "",
    kind,
    icon: {
      kind: "icon",
      value: kind === "project" ? "CubeIcon" : "File01Icon",
      color: "#a1a1aa",
    },
    description: "",
    title: "",
    summary: "",
    content: null,
    properties: emptyProperties(teamId),
    visibility: teamId ?? "",
    milestones: [],
    issues: [],
    subIssues: [],
    issueType: "standard",
    fields: [],
  }
}
