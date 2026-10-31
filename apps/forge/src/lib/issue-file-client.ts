import {
  canonicalIssueEpoch,
  canonicalIssueState,
  mergeCanonicalIssueRecords,
} from "./canonical-issue-cache"
import { persistIssueFiles } from "./issue-file-state"
import { productStorage, saveProductValue } from "./product-storage"
import { uploadFileDirect } from "./files/direct-upload-client"
import type { UploadSessions } from "./files/direct-upload-client"
import type { IssueDraft } from "./issue-record-contract"
import type { IssueFileCommand } from "./issue-file-contract"
import type { CanonicalSnapshot } from "./canonical-issue-cache"

export const issueFileDraftKey = (issueId: string, commentId?: string) =>
  `forge:file-draft:v1:${issueId}:${commentId ?? "issue"}`
export async function sendIssueFiles(input: IssueFileCommand) {
  const identity = canonicalIssueState(),
    epoch = canonicalIssueEpoch()
  if (!identity) throw new Error("Reload before changing files.")
  const key = issueFileDraftKey(input.issueId, input.commentId)
  await saveProductValue(key, JSON.stringify(input))
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  const result = JSON.parse(
    await persistIssueFiles({
      data: {
        ...input,
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
      },
    })
  ) as {
    status: "saved" | "rejected"
    message?: string
    records: CanonicalSnapshot["records"]
  }
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  mergeCanonicalIssueRecords(result.records)
  await saveProductValue(key, null)
  return result
}

export async function issueFileUrl(
  fileId: string,
  purpose: "download" | "preview"
) {
  const epoch = canonicalIssueEpoch()
  const response = await fetch(`/api/files/resources/${fileId}/grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose }),
  })
  const result = (await response.json()) as {
    url: string
    error?: { message: string }
  }
  if (!response.ok)
    throw new Error(result.error?.message ?? "The file is unavailable.")
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  return result.url
}

/** Creation retries reuse the issue receipt and each confirmed file binding. */
export async function finishCreatedIssueFiles(
  teamId: string,
  issueId: string,
  files: NonNullable<IssueDraft["attachments"]>,
  creationKey: string
) {
  const key = `forge:comment-draft:v1:${issueId}:creation-files:${creationKey}`
  const epoch = canonicalIssueEpoch()
  const state = JSON.parse(productStorage.getItem(key) ?? "null") ?? {
    issueId,
    next: 0,
    sessions: [],
  }
  const sessions: UploadSessions = new Map(state.sessions)
  const save = async () => {
    if (epoch !== canonicalIssueEpoch())
      throw new Error("The active session changed.")
    state.sessions = [...sessions]
    await saveProductValue(key, JSON.stringify(state))
  }
  try {
    for (; state.next < files.length;) {
      const file = files[state.next]
      if (!state.command) {
        if (file.fileId || !file.data.startsWith("data:"))
          throw new Error("Choose a new file for this issue.")
        const [header, encoded] = file.data.split(",")
        const contentType =
          header.slice(5).split(";")[0] || "application/octet-stream"
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
        const ready = await uploadFileDirect(
          {
            name: file.name,
            contentType,
            file: new Blob([bytes], { type: contentType }),
            target: { kind: "issue", id: issueId },
          },
          undefined,
          sessions
        )
        state.command = {
          commandKey: crypto.randomUUID(),
          teamId,
          issueId,
          action: "attach",
          fileIds: [ready.id],
        }
        await save()
      }
      const result = await sendIssueFiles(state.command)
      if (result.status === "rejected") throw new Error(result.message)
      delete state.command
      state.next++
      await save()
    }
  } catch (error) {
    if (epoch === canonicalIssueEpoch()) await save()
    throw error
  }
  // Keep the completed checkpoint until the caller has confirmed creation. A
  // lost final response must never upload the same creation's files again.
}
