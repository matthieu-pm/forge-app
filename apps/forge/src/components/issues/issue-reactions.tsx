import { useEffect, useState } from "react"
import { IssueIcon } from "./issue-controls"
import type { IssueDraft } from "@/lib/team-issues"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { normalizeReactionEmoji } from "@/lib/issue-engagement-contract"
import { cn } from "@/lib/utils"

type Reaction = IssueDraft["reactions"][number]

export function ReactionPicker({
  onChoose,
  label = "Add reaction",
  disabled = false,
}: {
  onChoose: (emoji: string) => void
  label?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [choices, setChoices] = useState<
    Array<{ emoji: string; label: string }>
  >([])
  useEffect(() => {
    if (disabled) setOpen(false)
    if (open && !disabled && !choices.length)
      void import("emojibase-data/en/compact.json").then(({ default: data }) =>
        setChoices(
          [...data]
            .sort((a, b) => (a.order ?? 99999) - (b.order ?? 99999))
            .map((item) => ({ emoji: item.unicode, label: item.label }))
        )
      )
  }, [open, choices.length, disabled])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ActionIconButton
            label={label}
            hintDisabled={open}
            disabled={disabled}
          />
        }
      >
        <IssueIcon name="reaction" />
      </PopoverTrigger>
      <PopoverContent className="w-72 gap-2 rounded-xl p-2">
        <input
          autoFocus
          placeholder="Search emoji…"
          aria-label="Search emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 w-full border-b border-border bg-transparent px-2 text-xs outline-none"
        />
        <div className="grid max-h-64 grid-cols-8 overflow-y-auto">
          {choices
            .filter(
              (item) => !query || item.label.includes(query.toLowerCase())
            )
            .map((item) => (
              <button
                key={item.emoji}
                title={item.label}
                aria-label={item.label}
                className="flex size-8 items-center justify-center rounded text-lg hover:bg-muted"
                disabled={disabled}
                onClick={() => {
                  onChoose(item.emoji)
                  setOpen(false)
                }}
              >
                {item.emoji}
              </button>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function Reactions({
  items,
  user,
  onChange,
  onToggle,
  disabled = false,
}: {
  items: Array<Reaction>
  user: string
  onChange?: (next: Array<Reaction>) => void
  onToggle?: (emoji: string, present: boolean) => void
  disabled?: boolean
}) {
  function toggle(emoji: string) {
    const existing = items.find(
      (item) =>
        normalizeReactionEmoji(item.emoji) === normalizeReactionEmoji(emoji)
    )
    if (disabled) return
    if (onToggle) {
      onToggle(emoji, !existing?.users.includes(user))
      return
    }
    const next = existing
      ? items
          .map((item) =>
            item === existing
              ? {
                  ...item,
                  users: item.users.includes(user)
                    ? item.users.filter((id) => id !== user)
                    : [...item.users, user],
                }
              : item
          )
          .filter((item) => item.users.length)
      : [...items, { emoji, users: [user] }]
    onChange?.(next)
  }
  return (
    <div className="flex items-center gap-1">
      {items.map((item) => (
        <button
          key={item.emoji}
          aria-pressed={item.users.includes(user)}
          aria-label={`${item.emoji}: ${item.users.length} reactions`}
          disabled={disabled}
          title={`${item.users.length} reaction${item.users.length === 1 ? "" : "s"}`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full border border-border px-2 text-xs",
            item.users.includes(user) && "border-[#5e6ad2]/40 bg-[#5e6ad2]/20"
          )}
          onClick={() => toggle(item.emoji)}
        >
          {item.emoji}
          <span>{item.users.length}</span>
        </button>
      ))}
      <ReactionPicker onChoose={toggle} disabled={disabled} />
    </div>
  )
}
