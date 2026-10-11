"use client"

import * as React from "react"
import { format } from "date-fns"
import { HugeiconsIcon } from "@hugeicons/react"
import { MoreHorizontalIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import type { TeamLabel } from "@/lib/team-labels"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TableCell, TableRow } from "@/components/ui/table"

const colors = [
  { name: "Grey", value: "#bec2c8" },
  { name: "Dark Grey", value: "#95a2b3" },
  { name: "Purple", value: "#5e6ad2" },
  { name: "Teal", value: "#26b5ce" },
  { name: "Green", value: "#4cb782" },
  { name: "Yellow", value: "#f2c400" },
  { name: "Orange", value: "#f2994a" },
  { name: "Pink", value: "#f7c5c0" },
  { name: "Red", value: "#eb5757" },
]
const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const inputClass =
  "h-7 rounded-md border-border/50 bg-muted/40 px-1.5 shadow-none focus-visible:border-border focus-visible:ring-1 dark:bg-muted/40"

export type NewTeamLabelRowHandle = { finish: () => boolean }
type Columns = {
  description: boolean
  issues: boolean
  lastApplied: boolean
  created: boolean
}

export function NewTeamLabelRow({
  ref,
  label,
  columns,
  rowClassName,
  saved,
  onSave,
  onClose,
  onDelete,
}: {
  ref?: React.Ref<NewTeamLabelRowHandle>
  label: TeamLabel
  columns: Columns
  rowClassName: string
  saved: boolean
  onSave: (label: TeamLabel) => string | undefined
  onClose: () => void
  onDelete: () => void
}) {
  const [name, setName] = React.useState(label.name)
  const [description, setDescription] = React.useState(label.description)
  const [color, setColor] = React.useState(label.color)
  const [editingName, setEditingName] = React.useState(true)
  const [editingDescription, setEditingDescription] = React.useState(false)
  const [selected, setSelected] = React.useState(false)
  const [error, setError] = React.useState("")
  const [colorOpen, setColorOpen] = React.useState(false)
  const [customColor, setCustomColor] = React.useState(false)
  const [customHex, setCustomHex] = React.useState(color)
  const nameInput = React.useRef<HTMLInputElement>(null)
  const descriptionButton = React.useRef<HTMLButtonElement>(null)
  const cancelled = React.useRef(false)
  const errorId = React.useId()

  function commit(next = { name, description, color }) {
    if (cancelled.current) return false
    if (!next.name.trim()) return false
    const failure = onSave({
      ...label,
      ...next,
      name: next.name.trim(),
      description: next.description.trim(),
    })
    setError(failure ?? "")
    if (failure) return false
    setName(next.name.trim())
    setDescription(next.description.trim())
    return true
  }

  function cancel() {
    cancelled.current = true
    onClose()
  }

  React.useImperativeHandle(ref, () => ({
    finish() {
      if (commit()) return true
      setEditingName(true)
      nameInput.current?.focus()
      return false
    },
  }))

  function changeColor(value: string) {
    if (name.trim() && !commit({ name, description, color: value })) return
    setColor(value)
    setColorOpen(false)
  }

  return (
    <>
      <TableRow
        className={rowClassName}
        data-state={selected ? "selected" : undefined}
      >
        <TableCell className="p-0 sm:pl-2">
          <Checkbox
            aria-label="Select new label"
            checked={selected}
            onCheckedChange={setSelected}
            className="size-3.5 rounded-[3px] border-muted-foreground/50 bg-transparent dark:bg-transparent"
          />
        </TableCell>
        <TableCell className="px-0 py-0">
          <div className="flex min-h-11 items-center gap-2">
            <Popover
              open={colorOpen}
              onOpenChange={(open) => {
                setColorOpen(open)
                if (!open) setCustomColor(false)
              }}
            >
              <PopoverTrigger
                aria-label="Change label color"
                className={`-ml-2 flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted/60 ${focusClass}`}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
              </PopoverTrigger>
              <PopoverContent
                align="center"
                sideOffset={3}
                aria-label="Label color"
                className="w-[414px] max-w-[calc(100vw-2rem)] gap-3 rounded-md p-3 data-open:animate-none data-closed:animate-none"
              >
                {customColor ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (/^#[0-9a-f]{6}$/i.test(customHex))
                        changeColor(customHex)
                    }}
                    className="flex items-center gap-2"
                  >
                    <Input
                      type="color"
                      aria-label="Custom color picker"
                      value={
                        /^#[0-9a-f]{6}$/i.test(customHex) ? customHex : color
                      }
                      onChange={(event) => setCustomHex(event.target.value)}
                      className="size-8 shrink-0 p-0.5"
                    />
                    <Input
                      aria-label="Custom color hex"
                      autoFocus
                      value={customHex}
                      onChange={(event) => setCustomHex(event.target.value)}
                      maxLength={7}
                      pattern="#[0-9a-fA-F]{6}"
                      required
                      className="h-8 min-w-0 rounded-md"
                    />
                    <Button type="submit" size="sm" className="rounded-md">
                      Apply
                    </Button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-3.5">
                    {colors.map((swatch) => (
                      <button
                        key={swatch.value}
                        type="button"
                        aria-label={swatch.name}
                        aria-pressed={color === swatch.value}
                        title={swatch.name}
                        onClick={() => changeColor(swatch.value)}
                        className={`flex size-6 shrink-0 items-center justify-center rounded-full ${focusClass}`}
                        style={{ backgroundColor: swatch.value }}
                      >
                        {color === swatch.value && (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            strokeWidth={1.5}
                            className="size-3.5 text-black/60"
                          />
                        )}
                      </button>
                    ))}
                    <div className="border-l border-border pl-3.5">
                      <button
                        type="button"
                        aria-label="Set custom color"
                        title="Set custom color"
                        onClick={() => {
                          setCustomHex(color)
                          setCustomColor(true)
                        }}
                        className={`size-6 rounded-full ${focusClass}`}
                        style={{
                          background:
                            "conic-gradient(#ef5555, #f2c94c, #4cb782, #26b5ce, #5e6ad2, #ef5555)",
                        }}
                      />
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
            {editingName ? (
              <Input
                ref={nameInput}
                autoFocus
                aria-label="Label name"
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                placeholder="Label name"
                maxLength={80}
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setError("")
                }}
                onBlur={() => {
                  if (commit()) setEditingName(false)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === "Enter") {
                    event.preventDefault()
                    if (commit()) {
                      setEditingName(false)
                      descriptionButton.current?.focus()
                    }
                  }
                  if (event.key === "Escape") {
                    event.preventDefault()
                    event.stopPropagation()
                    cancel()
                  }
                }}
                className={`${inputClass} w-[150px] max-w-[calc(100%-2rem)]`}
              />
            ) : (
              <button
                type="button"
                aria-label={`Edit label name ${name}`}
                onClick={() => setEditingName(true)}
                className={`truncate rounded-sm px-1.5 py-1 text-sm ${focusClass}`}
              >
                {name}
              </button>
            )}
          </div>
        </TableCell>
        {columns.description && (
          <TableCell className="px-0 py-0 pr-5">
            {editingDescription ? (
              <Input
                autoFocus
                aria-label="Label description"
                placeholder="Add label description..."
                maxLength={500}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onBlur={() => {
                  if (!name.trim() || commit()) setEditingDescription(false)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === "Enter") {
                    event.preventDefault()
                    if (commit()) setEditingDescription(false)
                  }
                  if (event.key === "Escape") {
                    event.preventDefault()
                    event.stopPropagation()
                    cancel()
                  }
                }}
                className={`${inputClass} w-[200px] max-w-full`}
              />
            ) : (
              <button
                ref={descriptionButton}
                type="button"
                onClick={() => setEditingDescription(true)}
                className={`max-w-full truncate rounded-sm py-1 text-left text-sm ${description ? "text-foreground/90" : "text-muted-foreground/50"} ${focusClass}`}
                title={description || undefined}
              >
                {description || "Add label description..."}
              </button>
            )}
          </TableCell>
        )}
        {columns.issues && <TableCell className="px-0" />}
        {columns.lastApplied && <TableCell className="px-0" />}
        {columns.created && (
          <TableCell className="px-0 text-xs text-muted-foreground">
            {format(new Date(label.createdAt), "MMM d")}
          </TableCell>
        )}
        <TableCell className="p-0 pr-2 text-right">
          <DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New label options"
              render={<DropdownMenuTrigger />}
              className="size-7 rounded-md text-muted-foreground"
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                strokeWidth={1.5}
                className="size-4"
              />
            </Button>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuItem
                disabled={!name.trim()}
                onClick={() => {
                  if (commit()) {
                    setEditingName(false)
                    setEditingDescription(false)
                  }
                }}
              >
                Save label
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={saved ? onDelete : cancel}
              >
                {saved ? "Delete label" : "Discard label"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>
      {error && (
        <TableRow className="border-0 hover:bg-transparent">
          <TableCell
            colSpan={3 + Object.values(columns).filter(Boolean).length}
            className="py-1 pl-4 sm:pl-8"
          >
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
