import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { EditorEmoticons } from "../lib/editor-emoticons"

let enabled = false
const editor = new Editor({
  element: document.querySelector<HTMLElement>("#editor")!,
  extensions: [
    StarterKit.configure({ trailingNode: false }),
    EditorEmoticons.configure({ enabled: () => enabled }),
  ],
  editorProps: { attributes: { role: "textbox", "aria-label": "Comment" } },
})
Object.assign(window, {
  emoticonsFixture: {
    editor,
    enable: (value: boolean) => {
      enabled = value
    },
  },
})
