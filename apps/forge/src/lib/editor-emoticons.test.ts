import { Editor, Node } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { afterEach, describe, expect, it } from "vitest"
import { EditorEmoticons, typedEmoticons } from "./editor-emoticons"

const instances: Array<Editor> = []
function editor(enabled = () => true, content = "<p></p>") {
  const instance = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      EditorEmoticons.configure({ enabled }),
      Node.create({
        name: "mention",
        group: "inline",
        inline: true,
        atom: true,
        renderHTML: () => ["span", "@Member"],
      }),
    ],
    content,
  })
  instances.push(instance)
  return instance
}
function type(instance: Editor, text: string) {
  for (const character of text) {
    const { from, to } = instance.state.selection
    const handled = instance.view.someProp("handleTextInput", (handler) =>
      handler(instance.view, from, to, character, () =>
        instance.state.tr.insertText(character, from, to)
      )
    )
    if (!handled)
      instance.view.dispatch(instance.state.tr.insertText(character, from, to))
  }
}
afterEach(() => instances.splice(0).forEach((instance) => instance.destroy()))

describe("FOR-132 AT-01 typed emoticons", () => {
  it.each(Object.entries(typedEmoticons))(
    "converts %s only after Space",
    (token, emoji) => {
      const instance = editor()
      type(instance, token)
      expect(instance.getText()).toBe(token)
      type(instance, " ")
      expect(instance.getText()).toBe(`${emoji} `)
      expect(instance.state.selection.from).toBe(emoji.length + 2)
      instance.commands.undo()
      expect(instance.getText()).toBe(`${token} `)
      instance.commands.redo()
      expect(instance.getText()).toBe(`${emoji} `)
    }
  )

  it("reads the current setting without resetting the editor or history", () => {
    let enabled = false
    const instance = editor(() => enabled)
    type(instance, ":) ")
    expect(instance.getText()).toBe(":) ")
    enabled = true
    type(instance, ";) ")
    expect(instance.getText()).toBe(":) 😉 ")
    enabled = false
    type(instance, ":D ")
    expect(instance.getText()).toBe(":) 😉 :D ")
  })

  it("preserves surrounding content, inline atoms, formatting and the caret", () => {
    const instance = editor()
    instance.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Before ", marks: [{ type: "bold" }] },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    })
    instance.commands.setTextSelection(8)
    instance.commands.insertContent({ type: "mention" })
    type(instance, " ")
    instance.commands.setMark("bold")
    type(instance, ":) ")
    expect(instance.getText()).toBe("Before  🙂 \n\nAfter")
    expect(instance.getJSON().content[0].content).toEqual([
      { type: "text", marks: [{ type: "bold" }], text: "Before " },
      { type: "mention" },
      { type: "text", text: " " },
      { type: "text", marks: [{ type: "bold" }], text: "🙂 " },
    ])
    const cursor = instance.state.selection.from
    type(instance, "next")
    expect(instance.state.selection.from).toBe(cursor + 4)
    expect(instance.getText()).toContain("🙂 next")
  })
})

describe("FOR-132 AT-02 protected input", () => {
  it.each([
    "https://example.test/:)",
    "www.example.test/:)",
    "user@example.test/:)",
    "word:)",
    ":P",
    ":/",
    "<3",
  ])("leaves the token %s untouched", (text) => {
    const instance = editor()
    type(instance, `${text} `)
    expect(instance.getText()).toBe(`${text} `)
  })

  it.each(["code", "link"])(
    "preserves %s marks including stored marks",
    (mark) => {
      const instance = editor()
      instance.commands.setMark(
        mark,
        mark === "link" ? { href: "https://example.test" } : {}
      )
      type(instance, ":) ")
      expect(instance.getText()).toBe(":) ")
      expect(instance.getJSON().content[0].content?.[0].marks?.[0].type).toBe(
        mark
      )
    }
  )

  it("preserves code blocks and mixed protected marks across a token", () => {
    const instance = editor()
    instance.commands.setCodeBlock()
    type(instance, ":) ")
    expect(instance.getJSON().content[0].type).toBe("codeBlock")
    expect(instance.getText()).toBe(":) ")
    instance.commands.setContent("<p></p>")
    instance.commands.setMark("code")
    type(instance, ":")
    instance.commands.unsetMark("code")
    type(instance, ") ")
    expect(instance.getText()).toBe(":) ")
  })

  it("preserves restored and inserted structured content even on the next typed space", () => {
    const instance = editor(() => true, "<p>:)</p>")
    instance.commands.setTextSelection(3)
    type(instance, " ")
    expect(instance.getText()).toBe(":) ")
    instance.commands.insertContent(
      "<p><strong>:-)</strong> <code>:D</code></p>"
    )
    type(instance, " ")
    expect(instance.getText()).not.toMatch(/[🙂😃]/u)
    expect(instance.getHTML()).toContain("<strong>:-)</strong>")
    expect(instance.getHTML()).toContain("<code>:D </code>")
  })

  it("does not transform selection replacement or a token joined to following text", () => {
    const instance = editor(() => true, "<p>keep this</p>")
    instance.commands.setTextSelection({ from: 1, to: 5 })
    type(instance, ":) ")
    expect(instance.getText()).toBe(":)  this")
    instance.commands.setContent("<p>suffix</p>")
    instance.commands.setTextSelection(1)
    type(instance, ":) ")
    expect(instance.getText()).toBe(":) suffix")
  })

  it("preserves active composition and does not transform at compositionend", async () => {
    const instance = editor()
    instance.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true })
    )
    type(instance, ":) ")
    expect(instance.getText()).toBe(":) ")
    instance.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true })
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(instance.getText()).toBe(":) ")
    type(instance, ";) ")
    expect(instance.getText()).toBe(":) 😉 ")
  })
})
