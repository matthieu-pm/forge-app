import type { JSONContent } from "@tiptap/core"
import type { ReactNode } from "react"
import type { PickerIcon } from "@/components/team-icon-picker"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { RichEditor } from "@/components/templates/rich-editor"
import { cn } from "@/lib/utils"

// Shared writing surface for team, project, and Signals documents.
export function DocumentContent({
  title,
  body,
  icon,
  onTitleChange,
  onBodyChange,
  onIconChange,
  wide = false,
  autoFocus = false,
  editable = true,
  metadata,
  children,
}: {
  title: string
  body: JSONContent
  icon: PickerIcon
  onTitleChange: (title: string) => void
  onBodyChange: (body: JSONContent) => void
  onIconChange: (icon: PickerIcon) => void
  wide?: boolean
  autoFocus?: boolean
  editable?: boolean
  metadata?: ReactNode
  children?: ReactNode
}) {
  return (
    <article
      className={cn(
        "mx-auto w-full max-w-[888px] px-6 pt-16 pb-24 sm:px-10",
        wide && "max-w-none"
      )}
    >
      {editable ? (
        <TeamIconPicker
          label="Document icon"
          name={title}
          value={icon}
          onChange={onIconChange}
          className="mb-2 size-9 rounded-lg border border-border/30 bg-transparent text-muted-foreground"
        />
      ) : (
        <TeamSidebarIcon icon={icon} name={title} className="mb-2 size-9" />
      )}
      <input
        autoFocus={autoFocus}
        aria-label="Document title"
        placeholder="New document"
        maxLength={200}
        value={title}
        readOnly={!editable}
        onChange={(event) => onTitleChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          event.currentTarget.parentElement
            ?.querySelector<HTMLElement>('[aria-label="Document content"]')
            ?.focus()
        }}
        className="mb-7 h-10 w-full min-w-0 border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/55"
      />
      {metadata}
      <RichEditor
        value={body}
        label="Document content"
        placeholder="Start writing..."
        className="min-h-[360px]"
        onChange={onBodyChange}
        editable={editable}
      />
      {children}
    </article>
  )
}
