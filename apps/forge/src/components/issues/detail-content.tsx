import { useEffect, useRef, useState } from "react"
import type { Editor, JSONContent } from "@tiptap/core"
import { RichEditor } from "@/components/templates/rich-editor"
import { cn } from "@/lib/utils"

/** The inline title field shared by issue and review details. */
export function DetailTitle({
  value,
  onSave,
  label,
  editable = true,
  onEditingStart,
  className,
}: {
  value: string
  onSave: (value: string) => boolean | void
  label: string
  editable?: boolean
  onEditingStart?: () => void
  className?: string
}) {
  const [title, setTitle] = useState(value)
  const canceled = useRef(false)
  const dirty = useRef(false)
  useEffect(() => {
    if (!dirty.current) setTitle(value)
  }, [value])
  return (
    <input
      aria-label={label}
      readOnly={!editable}
      value={title}
      maxLength={240}
      onChange={(event) => {
        if (!dirty.current) onEditingStart?.()
        dirty.current = true
        setTitle(event.target.value)
      }}
      onBlur={() => {
        if (canceled.current) {
          canceled.current = false
          dirty.current = false
          setTitle(value)
          return
        }
        const next = title.trim()
        if (!next || (next !== value && onSave(next) === false)) setTitle(value)
        else setTitle(next)
        dirty.current = false
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === "Escape") {
          event.preventDefault()
          canceled.current = true
          setTitle(value)
          event.currentTarget.blur()
        }
      }}
      className={cn(
        "mb-5 w-full bg-transparent text-2xl font-semibold outline-none",
        className
      )}
    />
  )
}
function plainDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  }
}
function docText(doc: JSONContent): string {
  return (
    doc.text ??
    doc.content?.map(docText).join(doc.type === "doc" ? "\n" : "") ??
    ""
  )
}
/** The same rich-text surface and autosave boundary used by issue details. */
export function DetailDescription({
  value,
  document,
  label,
  onSave,
  editable = true,
  onEditingStart,
}: {
  value: string
  document?: Record<string, unknown> | null
  label: string
  onSave: (text: string, document: JSONContent) => boolean | void
  editable?: boolean
  onEditingStart?: () => void
}) {
  const [doc, setDoc] = useState<JSONContent>(() => document ?? plainDoc(value))
  const editor = useRef<Editor | null>(null)
  const latest = useRef({ doc, dirty: false })
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  function persist() {
    const current = latest.current
    if (
      current.dirty &&
      saveRef.current(docText(current.doc), current.doc) !== false
    )
      current.dirty = false
  }
  useEffect(() => {
    if (latest.current.dirty) return
    const next = document ?? plainDoc(value)
    if (JSON.stringify(next) === JSON.stringify(latest.current.doc)) return
    latest.current.doc = next
    setDoc(next)
    editor.current?.commands.setContent(next, { emitUpdate: false })
  }, [value, document])
  useEffect(() => {
    if (!latest.current.dirty) return
    const timeout = window.setTimeout(persist, 600)
    return () => window.clearTimeout(timeout)
  }, [doc])
  useEffect(() => () => persist(), [])
  return (
    <div
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) persist()
      }}
    >
      <RichEditor
        value={doc}
        onChange={(next) => {
          if (!latest.current.dirty) onEditingStart?.()
          latest.current = { doc: next, dirty: true }
          setDoc(next)
        }}
        editorRef={editor}
        label={label}
        placeholder="Add description…"
        editable={editable}
        className="min-h-14 border-0 bg-transparent p-0"
      />
    </div>
  )
}
