import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ActivityComposer, blankActivityDraft } from "./initiative-activity"

afterEach(cleanup)
it("FOR-58 review: a later failed file preserves every earlier successful private upload in the draft", async () => {
  const uploaded = {
    id: "file",
    fileId: "00000000-0000-4000-8000-000000000001",
    name: "valid.txt",
    mime: "text/plain",
  }
  const upload = vi
    .fn()
    .mockResolvedValueOnce(uploaded)
    .mockRejectedValueOnce(new Error("Type not allowed"))
  const saved = vi.fn()
  function Composer() {
    const [draft, setDraft] = useState(blankActivityDraft)
    return (
      <ActivityComposer
        subject="Project"
        draft={draft}
        onDraft={(next) => {
          saved(next)
          setDraft(next)
        }}
        onPublish={() => true}
        writable
        onAsk={() => {}}
        uploadAttachment={upload}
      />
    )
  }
  render(<Composer />)
  fireEvent.change(screen.getByLabelText("Project attachments"), {
    target: {
      files: [
        new File(["first"], "valid.txt"),
        new File(["second"], "denied.bin"),
      ],
    },
  })
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Type not allowed")
  )
  expect(saved).toHaveBeenCalledWith(
    expect.objectContaining({ attachments: [uploaded] })
  )
  expect(screen.getByText("valid.txt")).toBeTruthy()
})
