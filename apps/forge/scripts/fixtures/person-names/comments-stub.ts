import { people } from "./data"

export async function loadCommentMentions() {
  return { targets: people, canModerate: false }
}
export async function persistIssueComment({ data }: { data: unknown }) {
  window.dispatchEvent(new CustomEvent("fixture:comment", { detail: data }))
  return JSON.stringify({ status: "saved", records: [] })
}
