import { protectedSessionEpoch } from "./protected-session"
import {
  canonicalIssueEpoch,
  canonicalIssueState,
  mergeCanonicalIssueRecords,
} from "./canonical-issue-cache"
import { persistIssueFiles } from "./issue-file-state"
import { productStorage, saveProductValue } from "./product-storage"
import {
  creationFileJobKey,
  creationFileJobSchema,
} from "./issue-file-contract"
import {
  UploadClientError,
  uploadFileDirect,
} from "./files/direct-upload-client"
import type { CreationFileJob, IssueFileCommand } from "./issue-file-contract"
import type {
  UploadContext,
  UploadSessions,
} from "./files/direct-upload-client"
import type { IssueDraft } from "./issue-record-contract"
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
  // An old mounted view can finish after a newer view has queued another command.
  let storedCommand: string | undefined
  try {
    storedCommand = JSON.parse(
      productStorage.getItem(key) ?? "null"
    )?.commandKey
  } catch {
    /* Keep unknown recovery content. */
  }
  if (storedCommand === input.commandKey) await saveProductValue(key, null)
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

/** Bind every app request to the identity that selected the private bytes. */
export function issueUploadContext(signal?: AbortSignal): UploadContext {
  const protectedEpoch = protectedSessionEpoch()
  const identity = canonicalIssueState(),
    epoch = canonicalIssueEpoch()
  if (!identity) throw new Error("Reload before uploading files.")
  return {
    signal,
    headers: {
      "x-forge-upload-session": identity.sessionId,
      "x-forge-upload-workspace": identity.workspaceId,
    },
    assertCurrent() {
      if (
        epoch !== canonicalIssueEpoch() ||
        protectedEpoch !== protectedSessionEpoch() ||
        signal?.aborted
      )
        throw new Error(
          "The upload was cancelled or the active session changed."
        )
    },
  }
}
export function readCreationFileJob(
  issueId: string
): CreationFileJob | undefined {
  try {
    const job = creationFileJobSchema.parse(
      JSON.parse(productStorage.getItem(creationFileJobKey(issueId)) ?? "null")
    )
    return job.issueId === issueId ? job : undefined
  } catch {
    return undefined
  }
}
const creationJobs = new Map<
  string,
  { controller: AbortController; promise: Promise<void> }
>()
const creationLockKey = (issueId: string) =>
  `${canonicalIssueEpoch()}:${issueId}`
export async function discardCreationFileJob(issueId: string) {
  const epoch = canonicalIssueEpoch()
  const active = creationJobs.get(creationLockKey(issueId))
  if (active) {
    active.controller.abort()
    await active.promise.catch(() => {})
  }
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  await saveProductValue(creationFileJobKey(issueId), null)
}
async function creationCommandKey(
  issueId: string,
  creationKey: string,
  index: number,
  operation: string
) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "forge:creation-file:v1",
          issueId,
          creationKey,
          index,
          operation,
        ])
      )
    )
  ).slice(0, 16)
  digest[6] = (digest[6] & 15) | 64
  digest[8] = (digest[8] & 63) | 128
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function finishCreatedIssueFiles(
  teamId: string,
  issueId: string,
  files: NonNullable<IssueDraft["attachments"]>,
  creationKey: string,
  initialize = false
) {
  const key = creationLockKey(issueId),
    active = creationJobs.get(key)
  if (active) return active.promise
  const controller = new AbortController()
  const promise = runCreationFiles(
    teamId,
    issueId,
    files,
    creationKey,
    initialize,
    controller.signal
  ).finally(() => {
    if (creationJobs.get(key)?.promise === promise) creationJobs.delete(key)
  })
  creationJobs.set(key, { controller, promise })
  return promise
}

/** The issue has already committed. Its private job survives rejection/reload. */
async function runCreationFiles(
  teamId: string,
  issueId: string,
  files: NonNullable<IssueDraft["attachments"]>,
  creationKey: string,
  initialize: boolean,
  signal: AbortSignal
) {
  const key = creationFileJobKey(issueId),
    context = issueUploadContext(signal)
  const existing = readCreationFileJob(issueId)
  if (!existing && !initialize)
    throw new Error("Pending files were discarded. Reload the issue.")
  const state =
    existing ??
    creationFileJobSchema.parse({ issueId, teamId, creationKey, files })
  if (state.creationKey !== creationKey || state.teamId !== teamId)
    throw new Error("Reload the issue before retrying its files.")
  if (state.completed) return
  const sessions: UploadSessions = new Map(state.sessions)
  const save = async () => {
    context.assertCurrent()
    state.sessions = [...sessions]
    await saveProductValue(key, JSON.stringify(state))
  }
  await save()
  try {
    for (; state.next < state.files.length;) {
      context.assertCurrent()
      const file = state.files[state.next]
      if (!state.command) {
        if (file.fileId || !file.data.startsWith("data:"))
          throw new Error("Choose a new file for this issue.")
        const [header, encoded] = file.data.split(",")
        const contentType =
          header.slice(5).split(";")[0] || "application/octet-stream"
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
        const uploadKey = await creationCommandKey(
          issueId,
          creationKey,
          state.next,
          `upload:${state.attempts[state.next] ?? 0}`
        )
        context.assertCurrent()
        const ready = await uploadFileDirect(
          {
            name: file.name,
            contentType,
            file: new Blob([bytes], { type: contentType }),
            target: { kind: "issue", id: issueId },
          },
          undefined,
          sessions,
          { ...context, commandKey: uploadKey }
        )
        context.assertCurrent()
        state.command = {
          commandKey: await creationCommandKey(
            issueId,
            creationKey,
            state.next,
            `bind:${state.attempts[state.next] ?? 0}`
          ),
          creationKey,
          creationIndex: state.next,
          teamId,
          issueId,
          action: "attach",
          fileIds: [ready.id],
        }
        await save()
      }
      context.assertCurrent()
      const result = await sendIssueFiles(state.command)
      if (result.status === "rejected") throw new Error(result.message)
      delete state.command
      state.next++
      await save()
    }
    state.completed = true
    state.files = []
    state.next = 0
    await save()
  } catch (error) {
    if (
      error instanceof UploadClientError &&
      ["INVALID_UPLOAD", "UPLOAD_CONFLICT", "FORBIDDEN"].includes(error.code)
    ) {
      state.attempts[state.next] = (state.attempts[state.next] ?? 0) + 1
    }
    // A switched identity must never receive the old identity's pending bytes.
    try {
      context.assertCurrent()
      await save()
    } catch {
      /* Existing server checkpoint remains. */
    }
    throw error
  }
}
