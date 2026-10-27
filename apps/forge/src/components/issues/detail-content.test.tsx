import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DetailDescription, DetailTitle } from "./detail-content"
import type { JSONContent } from "@tiptap/core"

const richDoc: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Formatted description",
          marks: [{ type: "bold" }],
        },
      ],
    },
  ],
}
vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: ({
    onChange,
    label,
  }: {
    onChange: (doc: JSONContent) => void
    label: string
  }) => (
    <button aria-label={label} onClick={() => onChange(richDoc)}>
      Edit rich description
    </button>
  ),
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
describe("Shared issue and review detail content", () => {
  it("saves a nonempty title on blur and cancels Escape edits", () => {
    const save = vi.fn()
    render(<DetailTitle label="Title" value="Original title" onSave={save} />)
    const field = screen.getByRole("textbox", { name: "Title" })
    fireEvent.change(field, { target: { value: "  New title  " } })
    fireEvent.blur(field)
    expect(save).toHaveBeenCalledWith("New title")
    save.mockClear()
    fireEvent.change(field, { target: { value: "Discard this edit" } })
    fireEvent.keyDown(field, { key: "Escape" })
    fireEvent.blur(field)
    expect(save).not.toHaveBeenCalled()
    expect((field as HTMLInputElement).value).toBe("Original title")
  })
  it("autosaves rich formatting and flushes pending description changes on unmount", () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const page = render(
      <DetailDescription label="Description" value="Original" onSave={save} />
    )
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Description" }))
    act(() => vi.advanceTimersByTime(600))
    expect(save).toHaveBeenCalledExactlyOnceWith(
      "Formatted description",
      richDoc
    )
    fireEvent.click(screen.getByRole("button", { name: "Description" }))
    page.unmount()
    expect(save).toHaveBeenCalledTimes(2)
    act(() => vi.advanceTimersByTime(600))
    expect(save).toHaveBeenCalledTimes(2)
  })
  it("retries a rejected description save when focus leaves the editor", () => {
    vi.useFakeTimers()
    const save = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    render(
      <DetailDescription label="Description" value="Original" onSave={save} />
    )
    const editor = screen.getByRole("button", { name: "Description" })
    fireEvent.click(editor)
    act(() => vi.advanceTimersByTime(600))
    fireEvent.blur(editor)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
