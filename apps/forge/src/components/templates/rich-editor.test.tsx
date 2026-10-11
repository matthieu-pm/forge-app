import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  RichEditor,
  insertFiles,
  richEditorExtensions,
  slashCommands,
} from "./rich-editor"
import { emptyTemplate, saveTemplateSchema } from "@/lib/template-contract"

vi.mock("@/components/team-icon-picker", () => ({ TeamIconPicker: () => null }))
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect(10, 10, 1, 20)
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
function editor() {
  return new Editor({ extensions: richEditorExtensions, content: "<p></p>" })
}
describe("Rich template content", () => {
  it("filters slash commands, selects with Enter, and keeps focus in the document", async () => {
    const ref = { current: null as Editor | null }
    render(
      <RichEditor
        value={null}
        onChange={() => {}}
        editorRef={ref}
        label="Brief"
      />
    )
    await waitFor(() => expect(ref.current).not.toBeNull())
    act(() => {
      ref.current!.commands.insertContent("/check")
    })
    expect(screen.getByRole("option", { name: "Checklist" })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Brief" }), {
      key: "Enter",
    })
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(ref.current!.getJSON().content[0].type).toBe("taskList")
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Brief" })
      )
    )
  })
  it("restores every advanced block and checked task state from saved JSON", () => {
    const original = editor()
    const content = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const answer = 42" }],
        },
        { type: "diagram", attrs: { source: "flowchart LR\nA --> B" } },
        {
          type: "details",
          attrs: { open: false },
          content: [
            {
              type: "detailsSummary",
              content: [{ type: "text", text: "Details" }],
            },
            {
              type: "detailsContent",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Hidden content" }],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "A quote" }] },
          ],
        },
        {
          type: "callout",
          attrs: { icon: { kind: "emoji", value: "🚀", color: "#52b3c5" } },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "A callout" }],
            },
          ],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Review" }],
                },
              ],
            },
          ],
        },
      ],
    }
    original.commands.setContent(content)
    const json = original.getJSON()
    const reopened = editor()
    reopened.commands.setContent(JSON.parse(JSON.stringify(json)))
    expect(reopened.getJSON()).toEqual(json)
    const payload = {
      ...emptyTemplate("document", "00000000-0000-4000-8000-000000000001"),
      name: "Brief",
      content: json,
    }
    expect(
      saveTemplateSchema.safeParse({ slug: "testing", payload }).success
    ).toBe(true)
    original.destroy()
    reopened.destroy()
  })
  it("inserts persistent image and downloadable file attachments", async () => {
    const instance = editor()
    await insertFiles(instance, [
      new File(["pixels"], "reference.png", { type: "image/png" }),
      new File(["brief"], "brief.txt", { type: "text/plain" }),
    ])
    const content = instance.getJSON()
    expect(
      content.content.find((node) => node.type === "image")?.attrs?.src
    ).toMatch(/^data:image\/png;base64,/)
    expect(
      content.content.find((node) => node.type === "attachment")?.attrs
    ).toMatchObject({
      name: "brief.txt",
      mime: "text/plain",
      src: "data:text/plain;base64,YnJpZWY=",
    })
    instance.destroy()
  })
  it("does not turn slash characters in code into commands", async () => {
    const ref = { current: null as Editor | null }
    render(<RichEditor value={null} onChange={() => {}} editorRef={ref} />)
    await waitFor(() => expect(ref.current).not.toBeNull())
    act(() => {
      slashCommands.find((command) => command.label === "Code block")!.action!(
        ref.current!
      )
      ref.current!.commands.insertContent("/check")
    })
    expect(screen.queryByRole("listbox")).toBeNull()
  })
})
