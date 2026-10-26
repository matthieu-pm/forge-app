import type { JSONContent } from "@tiptap/core"
import type { TeamResource } from "./team-home-state"

export const defaultDocumentIcon = {
  kind: "icon" as const,
  value: "File01Icon",
  color: "#94949e",
}

export function newTeamDocument(
  owner?: TeamResource["owner"],
  sectionId: string | null = null
): TeamResource {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    kind: "document",
    title: "New document",
    content: "",
    sectionId,
    createdAt: now,
    updatedAt: now,
    icon: defaultDocumentIcon,
    owner,
  }
}

export function teamDocumentBody(resource: TeamResource): JSONContent {
  return (
    resource.body ?? {
      type: "doc",
      content: resource.content.split("\n").map((text) => ({
        type: "paragraph",
        ...(text ? { content: [{ type: "text", text }] } : {}),
      })),
    }
  )
}

export function documentPlainText(body: JSONContent): string {
  if (body.type === "text") return body.text ?? ""
  if (body.type === "hardBreak") return "\n"
  const separator = [
    "doc",
    "bulletList",
    "orderedList",
    "taskList",
    "listItem",
    "taskItem",
  ].includes(body.type ?? "")
    ? "\n"
    : ""
  return (body.content ?? []).map(documentPlainText).join(separator)
}

export function documentTime(value: string): string {
  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) return "—"
  const elapsed = Math.max(0, Date.now() - time.getTime())
  if (elapsed < 60_000) return "just now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}min ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return time.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
