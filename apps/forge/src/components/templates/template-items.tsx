import * as React from "react"
import { toast } from "sonner"
import {
  Action,
  Glyph,
  Picker,
  Properties,
  StatusIcon,
} from "./template-controls"
import { RichEditor, insertFiles } from "./rich-editor"
import type { Editor, JSONContent } from "@tiptap/core"
import type { TemplateDirectory, TemplateItem } from "@/lib/template-contract"
import type { TeamSummary } from "@/lib/team-contract"
import { emptyProperties } from "@/lib/template-contract"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function ItemComposer({
  team,
  directory,
  onCancel,
  onAdd,
  initial,
  subIssue = false,
}: {
  team?: TeamSummary
  directory: TemplateDirectory
  onCancel: () => void
  onAdd: (item: TemplateItem, createMore: boolean) => void
  initial?: TemplateItem
  subIssue?: boolean
}) {
  const [title, setTitle] = React.useState(initial?.title ?? "")
  const [content, setContent] = React.useState<JSONContent | null>(
    initial?.content ?? null
  )
  const [properties, setProperties] = React.useState(
    initial?.properties ?? emptyProperties(team?.id)
  )
  const [createMore, setCreateMore] = React.useState(false)
  const [editorKey, setEditorKey] = React.useState(0)
  const editorRef = React.useRef<Editor | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const titleRef = React.useRef<HTMLInputElement>(null)
  function add() {
    if (!title.trim()) {
      titleRef.current?.focus()
      toast.error("Give the issue a title.")
      return
    }
    onAdd(
      {
        id: initial?.id ?? crypto.randomUUID(),
        title: title.trim(),
        content,
        properties,
      },
      createMore
    )
    if (createMore) {
      setTitle("")
      setContent(null)
      setEditorKey((i) => i + 1)
      titleRef.current?.focus()
    }
  }
  React.useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault()
        add()
      }
    }
    document.addEventListener("keydown", shortcut)
    return () => document.removeEventListener("keydown", shortcut)
  })
  const templates = directory.templates.filter(
    (t) => t.payload.kind === "issue" && t.payload.issueType === "standard"
  )
  return (
    <div className="rounded-xl border border-border/60 bg-muted/10 p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs text-muted-foreground">
          {initial
            ? "Edit issue"
            : subIssue
              ? "Create sub-issue"
              : "Create issue"}
        </h3>
        <Picker
          label="Apply issue template"
          value={null}
          options={templates.map((t) => ({
            value: t.id,
            label: t.payload.name,
            icon: (
              <TeamSidebarIcon icon={t.payload.icon} name={t.payload.name} />
            ),
          }))}
          empty="No standard issue templates yet."
          onChange={(id) => {
            const selected = templates.find((t) => t.id === id)
            if (selected) {
              setTitle(selected.payload.title)
              setContent(selected.payload.content)
              setProperties(selected.payload.properties)
              setEditorKey((i) => i + 1)
            }
          }}
          className="border-0 bg-transparent"
        >
          <Glyph name="document" />
          Template
        </Picker>
      </div>
      <div className="flex items-center gap-2">
        <StatusIcon status={properties.status} />
        <input
          ref={titleRef}
          aria-label="Issue title"
          autoFocus
          placeholder="Issue title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-transparent text-[13px] font-medium outline-none placeholder:text-muted-foreground/60"
        />
      </div>
      <div className="mt-2 ml-6 min-h-[110px]">
        <RichEditor
          key={editorKey}
          editorRef={editorRef}
          value={content}
          onChange={setContent}
          label="Issue description"
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Properties
          value={properties}
          onChange={setProperties}
          directory={directory}
          team={team}
        />
        <div className="flex-1" />
        <Action label="Attach files" onClick={() => fileRef.current?.click()}>
          ⌁
        </Action>
        <input
          hidden
          ref={fileRef}
          type="file"
          multiple
          onChange={(e) => {
            if (editorRef.current)
              void insertFiles(
                editorRef.current,
                Array.from(e.target.files ?? [])
              )
            e.target.value = ""
          }}
        />
        {!initial && (
          <label className="flex items-center gap-1.5 text-xs">
            <Switch
              checked={createMore}
              onCheckedChange={setCreateMore}
              size="sm"
            />
            Create more
          </label>
        )}
        <Button
          type="button"
          variant="ghost"
          className="h-6 rounded-full px-2 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-6 rounded-full bg-[#5e6ad2] px-2 text-xs text-white hover:bg-[#5360c8]"
          onClick={add}
        >
          {initial ? "Save issue" : subIssue ? "Add sub-issue" : "Add issue"}
        </Button>
      </div>
    </div>
  )
}
export function IssueItems({
  items,
  onChange,
  team,
  directory,
  creating,
  onCreatingChange,
  subIssues = false,
}: {
  items: Array<TemplateItem>
  onChange: (items: Array<TemplateItem>) => void
  team?: TeamSummary
  directory: TemplateDirectory
  creating: boolean
  onCreatingChange: (value: boolean) => void
  subIssues?: boolean
}) {
  const [expanded, setExpanded] = React.useState(true)
  const [editing, setEditing] = React.useState<TemplateItem | undefined>()
  const noun = subIssues ? "sub-issue" : "issue"
  if (!items.length && !creating) return null
  return (
    <div className="mt-3">
      {items.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-border/60 bg-muted/10">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="flex w-full items-center gap-1.5 p-3 text-left text-xs font-medium"
          >
            {subIssues ? "Sub-issues" : "Issues"}
            <span className="text-muted-foreground">{items.length}</span>
            <span className="text-[9px] text-muted-foreground">
              {expanded ? "▾" : "▸"}
            </span>
          </button>
          {expanded && (
            <>
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex min-h-10 items-center gap-2 px-4 text-xs"
                >
                  <StatusIcon status={item.properties.status} />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    onClick={() => {
                      setEditing(item)
                      onCreatingChange(true)
                    }}
                  >
                    {item.title}
                  </button>
                  <span className="flex items-center gap-1 rounded-full bg-background/60 px-2 py-0.5">
                    <TeamSidebarIcon
                      icon={
                        (
                          directory.teams.find(
                            (t) => t.id === item.properties.teamIds[0]
                          ) ?? team
                        )?.icon ?? {
                          kind: "icon",
                          value: "UserGroup03Icon",
                          color: "#94a3b8",
                        }
                      }
                      name={
                        (
                          directory.teams.find(
                            (t) => t.id === item.properties.teamIds[0]
                          ) ?? team
                        )?.name ?? "Team"
                      }
                    />
                    {(
                      directory.teams.find(
                        (t) => t.id === item.properties.teamIds[0]
                      ) ?? team
                    )?.identifier ?? "Team"}
                  </span>
                  <Picker
                    label={`Assign ${item.title}`}
                    value={item.properties.assignee}
                    options={[
                      { value: "", label: "No assignee" },
                      ...directory.members.map((m) => ({
                        value: m.id,
                        label: m.name,
                      })),
                    ]}
                    onChange={(id) =>
                      onChange(
                        items.map((i) =>
                          i.id === item.id
                            ? {
                                ...i,
                                properties: {
                                  ...i.properties,
                                  assignee: typeof id === "string" ? id : null,
                                },
                              }
                            : i
                        )
                      )
                    }
                    className="border-0 bg-transparent px-1"
                  >
                    <Glyph name="person" />
                  </Picker>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`Actions for ${item.title}`}
                          className="grid size-6 place-items-center rounded hover:bg-muted"
                        />
                      }
                    >
                      <Glyph name="more" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="w-36 rounded-lg"
                    >
                      <DropdownMenuItem
                        onClick={() => {
                          setEditing(item)
                          onCreatingChange(true)
                        }}
                      >
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          onChange([
                            ...items,
                            {
                              ...item,
                              id: crypto.randomUUID(),
                              title: `${item.title} copy`,
                            },
                          ])
                        }
                      >
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          onChange(items.filter((i) => i.id !== item.id))
                        }
                      >
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
              <div className="flex justify-end border-t border-border/30 px-2 py-1.5">
                <Action
                  label={`Add ${noun}`}
                  shortcut="⌘ ⇧ O"
                  onClick={() => {
                    setEditing(undefined)
                    onCreatingChange(true)
                  }}
                >
                  <Glyph name="add" />
                  Add {noun}
                </Action>
              </div>
            </>
          )}
        </section>
      )}
      {creating && (
        <div className={items.length ? "mt-3" : ""}>
          <ItemComposer
            key={editing?.id ?? "new"}
            team={team}
            directory={directory}
            initial={editing}
            subIssue={subIssues}
            onCancel={() => {
              onCreatingChange(false)
              setEditing(undefined)
            }}
            onAdd={(item, more) => {
              onChange(
                editing
                  ? items.map((i) => (i.id === item.id ? item : i))
                  : [...items, item]
              )
              if (!more) onCreatingChange(false)
              setEditing(undefined)
            }}
          />
        </div>
      )}
    </div>
  )
}
export function Milestones({
  items,
  onChange,
  creating,
  onCreatingChange,
}: {
  items: Array<{ id: string; title: string; content: JSONContent | null }>
  onChange: (
    items: Array<{ id: string; title: string; content: JSONContent | null }>
  ) => void
  creating: boolean
  onCreatingChange: (value: boolean) => void
}) {
  const [expanded, setExpanded] = React.useState(true)
  const [title, setTitle] = React.useState("")
  const [content, setContent] = React.useState<JSONContent | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editorKey, setEditorKey] = React.useState(0)
  function reset() {
    setEditingId(null)
    setTitle("")
    setContent(null)
    setEditorKey((i) => i + 1)
  }
  function start() {
    reset()
    onCreatingChange(true)
  }
  return (
    <div className="mt-5">
      <section className="overflow-hidden rounded-xl border border-border/60 bg-muted/10">
        {creating ? (
          <div className="p-3">
            <h3 className="mb-6 text-xs text-muted-foreground">
              {editingId ? "Edit milestone" : "Create milestone"}
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">◇</span>
              <input
                autoFocus
                aria-label="Milestone name"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Milestone name"
                className="w-full bg-transparent text-xs font-medium outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="mt-4 ml-6 min-h-[76px]">
              <RichEditor
                key={editorKey}
                label="Milestone description"
                value={content}
                onChange={setContent}
                placeholder="Add a description template..."
              />
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                className="h-6 rounded-full px-2 text-xs"
                onClick={() => {
                  reset()
                  onCreatingChange(false)
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="h-6 rounded-full bg-[#5e6ad2] px-2 text-xs text-white hover:bg-[#5360c8]"
                onClick={() => {
                  if (!title.trim()) {
                    toast.error("Give the milestone a name.")
                    return
                  }
                  const item = {
                    id: editingId ?? crypto.randomUUID(),
                    title: title.trim(),
                    content,
                  }
                  onChange(
                    editingId
                      ? items.map((i) => (i.id === editingId ? item : i))
                      : [...items, item]
                  )
                  reset()
                  onCreatingChange(false)
                }}
              >
                {editingId ? "Save milestone" : "Add milestone"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-h-11 items-center justify-between px-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs font-medium"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
              >
                Milestones
                {items.length > 0 && (
                  <>
                    <span className="text-muted-foreground">
                      {items.length}
                    </span>
                    <span className="text-[9px] text-muted-foreground">
                      {expanded ? "▾" : "▸"}
                    </span>
                  </>
                )}
              </button>
              {!items.length && (
                <Action label="Add milestone" shortcut="⌘ ⇧ M" onClick={start}>
                  <Glyph name="add" />
                </Action>
              )}
            </div>
            {expanded && items.length > 0 && (
              <>
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="flex min-h-10 items-center gap-2 px-4 text-xs"
                  >
                    <span className="text-muted-foreground">◇</span>
                    <button
                      type="button"
                      className="flex-1 text-left hover:underline"
                      onClick={() => {
                        setEditingId(item.id)
                        setTitle(item.title)
                        setContent(item.content)
                        setEditorKey((i) => i + 1)
                        onCreatingChange(true)
                      }}
                    >
                      {item.title}
                    </button>
                    <Action
                      label={`Remove milestone ${item.title}`}
                      onClick={() =>
                        onChange(items.filter((i) => i.id !== item.id))
                      }
                    >
                      <Glyph name="close" />
                    </Action>
                  </div>
                ))}
                <div className="flex justify-end border-t border-border/30 px-2 py-1.5">
                  <Action
                    label="Add milestone"
                    shortcut="⌘ ⇧ M"
                    onClick={start}
                  >
                    <Glyph name="add" />
                    Add milestone
                  </Action>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  )
}
