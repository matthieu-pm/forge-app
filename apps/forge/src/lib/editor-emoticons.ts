import { Extension } from "@tiptap/core"
import { closeHistory } from "@tiptap/pm/history"
import { Plugin, PluginKey } from "@tiptap/pm/state"

export const typedEmoticons: Readonly<Record<string, string>> = Object.freeze({
  ":)": "🙂",
  ":-)": "🙂",
  ":(": "🙁",
  ":-(": "🙁",
  ";)": "😉",
  ";-)": "😉",
  ":D": "😃",
  ":-D": "😃",
})

type TypedRun = { from: number; to: number }

/** Only literal text input participates; paste, commands and composition never do. */
export const EditorEmoticons = Extension.create<{ enabled: () => boolean }>({
  name: "editorEmoticons",
  // Observe literal typing before other input rules (e.g. Markdown) consume it.
  priority: 1100,
  addOptions: () => ({ enabled: () => false }),
  addProseMirrorPlugins() {
    const key = new PluginKey<TypedRun | null>("editorEmoticons")
    let input: { from: number; text: string } | null = null
    const enabled = this.options.enabled
    return [
      new Plugin<TypedRun | null>({
        key,
        state: {
          init: () => null,
          apply(tr, run) {
            const typed = input
            input = null
            if (tr.getMeta(key) === "reset") return null
            if (typed && tr.docChanged) {
              const end = typed.from + typed.text.length
              if (
                tr.selection.empty &&
                tr.selection.from === end &&
                tr.doc.textBetween(typed.from, end) === typed.text
              )
                return {
                  from: Math.max(
                    run?.to === typed.from ? run.from : typed.from,
                    end - 3
                  ),
                  to: end,
                }
            }
            return tr.docChanged || tr.selectionSet ? null : run
          },
        },
        props: {
          handleDOMEvents: {
            compositionstart: (view) => {
              input = null
              view.dispatch(view.state.tr.setMeta(key, "reset"))
              return false
            },
          },
          handleTextInput(view, from, to, text) {
            input = null
            const { state } = view
            if (
              !enabled() ||
              !view.editable ||
              view.composing ||
              !state.selection.empty ||
              from !== to
            )
              return false
            if (text !== " ") {
              // A multi-character insertion may be dictation or a replacement.
              if (text.length === 1) input = { from, text }
              return false
            }
            const run = key.getState(state)
            if (!run || run.to !== from) return false
            const { $from } = state.selection
            if (!$from.parent.isTextblock || $from.parent.type.spec.code)
              return false
            if (
              $from.nodeAfter?.isText &&
              /^\S/.test($from.nodeAfter.text ?? "")
            )
              return false
            const before = $from.parent.textBetween(
              0,
              $from.parentOffset,
              "\n",
              "\ufffc"
            )
            const match = /(?:^|\s)([:;]-?[)(]|:-?D)$/.exec(before)
            if (!match) return false
            const token = match[1],
              emoji = typedEmoticons[token],
              start = from - token.length
            if (!emoji || start < run.from) return false
            const protectedMark = (marks: typeof $from.parent.marks) =>
              marks.some(
                (mark) => mark.type.spec.code || mark.type.name === "link"
              )
            let protectedContent = protectedMark(
              state.storedMarks ?? $from.marks()
            )
            state.doc.nodesBetween(start, from, (node) => {
              if ((node.isInline && !node.isText) || protectedMark(node.marks))
                protectedContent = true
            })
            if (protectedContent) return false

            // Keep the typed space in history, then give conversion its own undo
            // event. Undo restores the literal token and space; redo converts it.
            const typed = state.tr.insertText(text, from, to)
            view.dispatch(typed)
            if (view.state.doc.eq(typed.doc))
              view.dispatch(
                closeHistory(view.state.tr).insertText(emoji, start, from)
              )
            return true
          },
        },
      }),
    ]
  },
})
