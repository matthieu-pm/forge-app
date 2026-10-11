import * as React from "react"
import { createPortal } from "react-dom"
import { Node, mergeAttributes } from "@tiptap/core"
import {
  EditorContent,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import Image from "@tiptap/extension-image"
import {
  Details,
  DetailsContent,
  DetailsSummary,
} from "@tiptap/extension-details"
import { toast } from "sonner"
import type { Editor, JSONContent } from "@tiptap/core"
import type { NodeViewProps } from "@tiptap/react"
import type { PickerIcon } from "@/components/team-icon-picker"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { cn } from "@/lib/utils"
import "./rich-editor.css"

function CalloutView({ node, updateAttributes }: NodeViewProps) {
  const icon = node.attrs.icon as PickerIcon
  return (
    <NodeViewWrapper
      className="template-callout"
      style={{
        borderColor: `${icon.color}40`,
        backgroundColor: `${icon.color}08`,
      }}
    >
      <span contentEditable={false}>
        <TeamIconPicker
          name="Callout"
          label="Choose callout icon"
          value={icon}
          onChange={(value) => updateAttributes({ icon: value })}
          className="size-6 rounded-md border-0 bg-transparent"
        />
      </span>
      <NodeViewContent className="min-w-0 flex-1" />
    </NodeViewWrapper>
  )
}
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({
    icon: { default: { kind: "icon", value: "Idea01Icon", color: "#52b3c5" } },
  }),
  parseHTML: () => [{ tag: "aside[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "aside",
    mergeAttributes(HTMLAttributes, { "data-callout": "true" }),
    0,
  ],
  addNodeView: () => ReactNodeViewRenderer(CalloutView),
})
function DiagramView({ node, updateAttributes }: NodeViewProps) {
  const [editing, setEditing] = React.useState(true)
  const [svg, setSvg] = React.useState("")
  const [error, setError] = React.useState("")
  const renderId = React.useId().replace(/[^a-z0-9]/gi, "")
  React.useEffect(() => {
    if (editing) return
    let cancelled = false
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
          suppressErrorRendering: true,
        })
        const result = await mermaid.render(
          `diagram${renderId}${Date.now()}`,
          String(node.attrs.source)
        )
        if (!cancelled) {
          setSvg(result.svg)
          setError("")
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg("")
          setError(
            "Diagram syntax could not be rendered. Edit the Mermaid source to fix it."
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [editing, node.attrs.source, renderId])
  return (
    <NodeViewWrapper className="template-diagram" contentEditable={false}>
      <div className="mb-2 flex justify-end gap-2 text-xs">
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-pressed={editing}
        >
          Code
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          aria-pressed={!editing}
        >
          Preview
        </button>
      </div>
      {editing ? (
        <textarea
          aria-label="Diagram source"
          spellCheck={false}
          value={String(node.attrs.source)}
          onChange={(event) => updateAttributes({ source: event.target.value })}
          className="min-h-24 w-full resize-y bg-transparent font-mono text-xs outline-none"
        />
      ) : error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {error}
        </p>
      ) : (
        <div
          className="flex justify-center"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </NodeViewWrapper>
  )
}
const Diagram = Node.create({
  name: "diagram",
  group: "block",
  atom: true,
  addAttributes: () => ({
    source: { default: "flowchart LR\n  Idea --> Build --> Launch" },
  }),
  parseHTML: () => [{ tag: "div[data-diagram]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-diagram": "true" }),
  ],
  addNodeView: () => ReactNodeViewRenderer(DiagramView),
})
function AttachmentView({ node }: NodeViewProps) {
  const { src, name, mime } = node.attrs as {
    src: string
    name: string
    mime: string
  }
  return (
    <NodeViewWrapper contentEditable={false} className="my-4">
      {mime.startsWith("video/") ? (
        <video controls src={src} className="max-h-96 rounded-lg" />
      ) : mime.startsWith("audio/") ? (
        <audio controls src={src} />
      ) : (
        <a
          href={src}
          download={name}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm"
        >
          ↧ {name}
        </a>
      )}
    </NodeViewWrapper>
  )
}
const Attachment = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  addAttributes: () => ({
    src: { default: "" },
    name: { default: "File" },
    mime: { default: "application/octet-stream" },
  }),
  parseHTML: () => [{ tag: "div[data-attachment]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-attachment": "true" }),
  ],
  addNodeView: () => ReactNodeViewRenderer(AttachmentView),
})
export const richEditorExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: { openOnClick: false },
  }),
  TaskList,
  TaskItem.configure({
    nested: true,
    HTMLAttributes: { "data-type": "taskItem" },
  }),
  Image.configure({ allowBase64: true }),
  Details.configure({ persist: true }),
  DetailsSummary,
  DetailsContent,
  Callout,
  Diagram,
  Attachment,
]
export const slashCommands = [
  {
    label: "Heading 1",
    icon: "H₁",
    search: "h1 title",
    action: (e: Editor) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    label: "Heading 2",
    icon: "H₂",
    search: "h2 subtitle",
    action: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    label: "Heading 3",
    icon: "H₃",
    search: "h3",
    action: (e: Editor) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    label: "Bulleted list",
    icon: "•",
    search: "unordered bullet",
    action: (e: Editor) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    icon: "1.",
    search: "ordered number",
    action: (e: Editor) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "Checklist",
    icon: "☑",
    search: "todo task checkbox",
    action: (e: Editor) => e.chain().focus().toggleTaskList().run(),
  },
  {
    label: "Insert media",
    icon: "▧",
    search: "image video audio upload",
    file: true,
  },
  { label: "Attach files", icon: "↧", search: "attachment upload", file: true },
  {
    label: "Code block",
    icon: "‹›",
    search: "code pre",
    action: (e: Editor) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: "Diagram",
    icon: "◇",
    search: "mermaid flowchart",
    action: (e: Editor) =>
      e
        .chain()
        .focus()
        .insertContent([{ type: "diagram" }, { type: "paragraph" }])
        .run(),
  },
  {
    label: "Collapsible section",
    icon: "▸",
    search: "toggle details",
    action: (e: Editor) =>
      e
        .chain()
        .focus()
        .insertContent({
          type: "details",
          attrs: { open: true },
          content: [
            {
              type: "detailsSummary",
              content: [{ type: "text", text: "Collapsible section" }],
            },
            { type: "detailsContent", content: [{ type: "paragraph" }] },
          ],
        })
        .run(),
  },
  {
    label: "Blockquote",
    icon: "❝",
    search: "quote",
    action: (e: Editor) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    label: "Callout",
    icon: "☀",
    search: "note aside",
    action: (e: Editor) =>
      e
        .chain()
        .focus()
        .insertContent({ type: "callout", content: [{ type: "paragraph" }] })
        .run(),
  },
]
type SlashState = {
  from: number
  to: number
  query: string
  left: number
  top: number
}
export function detectSlash(editor: Editor): SlashState | null {
  const { selection } = editor.state
  if (!selection.empty || selection.$from.parent.type.name === "codeBlock")
    return null
  const before = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    "\n",
    "\ufffc"
  )
  const match = /(?:^|\s)\/([^/\n]*)$/.exec(before)
  if (!match) return null
  const coords = editor.view.coordsAtPos(selection.from)
  return {
    from: selection.from - match[1].length - 1,
    to: selection.from,
    query: match[1],
    left: coords.left,
    top: coords.bottom + 8,
  }
}
export async function insertFiles(editor: Editor, files: Array<File>) {
  for (const file of files) {
    if (file.size > 4_000_000) {
      toast.error(`${file.name} is too large. Choose a file under 4 MB.`)
      continue
    }
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    if (editor.isDestroyed) return
    const node = /^image\/(png|jpeg|gif|webp)$/.test(file.type)
      ? { type: "image", attrs: { src, alt: file.name } }
      : {
          type: "attachment",
          attrs: {
            src,
            name: file.name,
            mime: file.type || "application/octet-stream",
          },
        }
    editor
      .chain()
      .focus()
      .insertContent([node, { type: "paragraph" }])
      .run()
  }
}
export function RichEditor({
  value,
  onChange,
  placeholder = "Add description...",
  label = "Description",
  className,
  editorRef,
}: {
  value: JSONContent | null
  onChange: (value: JSONContent) => void
  placeholder?: string
  label?: string
  className?: string
  editorRef?: React.RefObject<Editor | null>
}) {
  const [slash, setSlash] = React.useState<SlashState | null>(null)
  const [active, setActive] = React.useState(0)
  const [linkOpen, setLinkOpen] = React.useState(false)
  const [link, setLink] = React.useState("")
  const fileRef = React.useRef<HTMLInputElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const slashRef = React.useRef<{ slash: SlashState | null; active: number }>({
    slash: null,
    active: 0,
  })
  const updateRef = React.useRef(onChange)
  updateRef.current = onChange
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...richEditorExtensions,
      Placeholder.configure({ placeholder }),
    ],
    content: value ?? undefined,
    editorProps: {
      attributes: {
        class: "template-prose",
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        const state = slashRef.current
        if (!state.slash) return false
        const commands = filtered(state.slash.query)
        if (event.key === "Escape") {
          setSlash(null)
          slashRef.current.slash = null
          return true
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          setActive(
            (i) =>
              (i + (event.key === "ArrowDown" ? 1 : -1) + commands.length) %
              Math.max(1, commands.length)
          )
          return true
        }
        if (event.key === "Enter" && commands.length) {
          event.preventDefault()
          choose(commands[state.active % commands.length])
          return true
        }
        return false
      },
      handleDrop: (_view, event) => {
        if (!event.dataTransfer?.files.length) return false
        event.preventDefault()
        if (editor)
          void insertFiles(editor, Array.from(event.dataTransfer.files))
        return true
      },
      handlePaste: (_view, event) => {
        if (!event.clipboardData?.files.length) return false
        event.preventDefault()
        if (editor)
          void insertFiles(editor, Array.from(event.clipboardData.files))
        return true
      },
    },
    onUpdate: ({ editor: current }) => {
      updateRef.current(current.getJSON())
      const next = detectSlash(current)
      setSlash(next)
      setActive(0)
    },
    onSelectionUpdate: ({ editor: current }) => setSlash(detectSlash(current)),
    onBlur: () => {
      window.setTimeout(() => {
        if (!menuRef.current?.contains(document.activeElement)) setSlash(null)
      }, 100)
    },
  })
  slashRef.current = { slash, active }
  React.useEffect(() => {
    if (editorRef) editorRef.current = editor
    return () => {
      if (editorRef) editorRef.current = null
    }
  }, [editor, editorRef])
  function filtered(query: string) {
    return slashCommands.filter((c) =>
      `${c.label} ${c.search}`.toLowerCase().includes(query.toLowerCase())
    )
  }
  function choose(command: (typeof slashCommands)[number]) {
    const current = slashRef.current.slash
    if (!editor || !current) return
    editor
      .chain()
      .focus()
      .deleteRange({ from: current.from, to: current.to })
      .run()
    setSlash(null)
    slashRef.current.slash = null
    if (command.file) fileRef.current?.click()
    else command.action?.(editor)
  }
  const commands = slash ? filtered(slash.query) : []
  React.useEffect(() => {
    menuRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [active])
  return (
    <div className={cn("template-rich-editor relative", className)}>
      <EditorContent editor={editor} />
      <input
        type="file"
        ref={fileRef}
        hidden
        multiple
        aria-label="Attach files"
        onChange={(event) => {
          if (editor)
            void insertFiles(editor, Array.from(event.target.files ?? []))
          event.target.value = ""
        }}
      />
      {editor && (
        <BubbleMenu editor={editor}>
          <div className="flex gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg">
            {(
              [
                ["Bold", "B", "toggleBold"],
                ["Italic", "I", "toggleItalic"],
                ["Underline", "U", "toggleUnderline"],
                ["Strikethrough", "S", "toggleStrike"],
                ["Inline code", "‹›", "toggleCode"],
              ] as const
            ).map(([name, text, action]) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                className="size-7 rounded hover:bg-muted"
                onClick={() => editor.chain().focus()[action]().run()}
              >
                {text}
              </button>
            ))}
            <button
              type="button"
              aria-label="Insert link"
              className="px-2 hover:bg-muted"
              onClick={() => {
                setLink(String(editor.getAttributes("link").href ?? ""))
                setLinkOpen(true)
              }}
            >
              ↗
            </button>
            {linkOpen && (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!link || /^(https?:|mailto:)/i.test(link)) {
                    if (link)
                      editor.chain().focus().setLink({ href: link }).run()
                    else editor.chain().focus().unsetLink().run()
                    setLinkOpen(false)
                  } else toast.error("Use an https, http, or mailto link.")
                }}
              >
                <input
                  aria-label="Link URL"
                  autoFocus
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  className="w-48 px-2 outline-none"
                  placeholder="https://..."
                />
                <button type="submit">Apply</button>
              </form>
            )}
          </div>
        </BubbleMenu>
      )}
      {slash &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Insert block"
            className="fixed z-[100] max-h-[360px] w-60 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-sm shadow-xl"
            style={{
              left: Math.min(slash.left, window.innerWidth - 250),
              top: Math.min(slash.top, window.innerHeight - 370),
            }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {commands.length ? (
              commands.map((command, index) => (
                <button
                  type="button"
                  key={command.label}
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    "flex h-8 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-muted",
                    index === active && "bg-muted"
                  )}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(command)}
                >
                  <span
                    aria-hidden="true"
                    className="w-5 text-center font-medium text-muted-foreground"
                  >
                    {command.icon}
                  </span>
                  {command.label}
                </button>
              ))
            ) : (
              <p className="p-3 text-muted-foreground">No matching commands.</p>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
