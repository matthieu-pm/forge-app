import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { DurableIssueFiles, FileUploadPicker } from "./durable-issue-files"
import * as fileClient from "@/lib/issue-file-client"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import { uploadFileDirect } from "@/lib/files/direct-upload-client"

vi.mock("@/lib/files/direct-upload-client", () => ({
  uploadFileDirect: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  replaceCanonicalIssues(null, false)
})
it("aborts on unmount and prevents an old completion from overwriting a reopened draft", async () => {
  replaceCanonicalIssues({
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "alice-session",
    records: [],
    projects: [],
    cycles: [],
  })
  let complete!: (value: never) => void
  vi.mocked(uploadFileDirect).mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve
    })
  )
  const oldReady = vi.fn(),
    oldBusy = vi.fn(),
    newReady = vi.fn()
  const props = { issueId: crypto.randomUUID(), disabled: false, count: 0 }
  const old = render(
    <FileUploadPicker {...props} onBusy={oldBusy} onReady={oldReady} />
  )
  fireEvent.change(screen.getByLabelText("Upload attachment"), {
    target: { files: [new File(["Alice private bytes"], "private.txt")] },
  })
  const context = vi.mocked(uploadFileDirect).mock.calls[0][3]!
  expect(context.headers?.["x-forge-upload-session"]).toBe("alice-session")
  old.unmount()
  render(<FileUploadPicker {...props} onBusy={vi.fn()} onReady={newReady} />)
  expect(context.signal?.aborted).toBe(true)
  await act(async () => {
    complete({ id: crypto.randomUUID() } as never)
  })
  expect(oldReady).not.toHaveBeenCalled()
  expect(newReady).not.toHaveBeenCalled()
  expect(oldBusy.mock.calls).toEqual([[true]])
})

it("shows creation recovery only on the issue file list, never on its comments", () => {
  const issueId = crypto.randomUUID(),
    teamId = crypto.randomUUID()
  vi.spyOn(fileClient, "readCreationFileJob").mockReturnValue({
    issueId,
    teamId,
    creationKey: "create-key",
    next: 0,
    completed: false,
    sessions: [],
    attempts: {},
    files: [
      { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
    ],
  })
  const { rerender } = render(
    <DurableIssueFiles
      teamId={teamId}
      issueId={issueId}
      commentId={crypto.randomUUID()}
      items={[]}
      canEdit
    />
  )
  expect(
    screen.queryByRole("button", { name: "Finish file uploads" })
  ).toBeNull()
  rerender(
    <DurableIssueFiles teamId={teamId} issueId={issueId} items={[]} canEdit />
  )
  expect(
    screen.getByRole("button", { name: "Finish file uploads" })
  ).toBeTruthy()
})
