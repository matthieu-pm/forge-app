"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Archive01Icon,
  Building02Icon,
  Cancel01Icon,
  CommandIcon,
  Delete02Icon,
  PathfinderMergeIcon,
  StarIcon,
} from "@hugeicons/core-free-icons"
import type { TeamLabel } from "@/lib/team-labels"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

export function LabelSelectionActions({
  labels,
  workspace,
  onClear,
  onFavorite,
  onMove,
  onMerge,
  onArchive,
  onDelete,
}: {
  labels: Array<TeamLabel>
  workspace: boolean
  onClear: () => void
  onFavorite: () => boolean
  onMove?: () => boolean
  onMerge: (targetId: string) => boolean
  onArchive: () => boolean
  onDelete: () => boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [merging, setMerging] = React.useState(false)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const allFavorite = labels.every((label) => label.favorite)
  const allArchived = labels.every((label) => label.archived)

  function openMenu() {
    setSearch("")
    setMerging(false)
    setOpen(true)
  }
  function run(action: () => boolean) {
    if (action()) setOpen(false)
  }

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearch("")
        setMerging(false)
        setOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <>
      <div className="pointer-events-none fixed right-0 bottom-8 left-0 z-40 flex justify-center md:bottom-12 md:left-(--sidebar-width)">
        <div
          role="toolbar"
          aria-label="Selected label actions"
          className="pointer-events-auto flex h-11 max-w-[calc(100vw-2rem)] items-center gap-3 rounded-full border border-border/40 bg-popover py-1.5 pr-2 pl-5 shadow-lg"
        >
          <span
            role="status"
            className="text-xs whitespace-nowrap text-foreground/90"
          >
            {labels.length} selected
          </span>
          <Button
            ref={trigger}
            variant="secondary"
            size="sm"
            onClick={openMenu}
            aria-label="Open label command menu"
            className="h-7 gap-1.5 rounded-full px-2.5 text-xs font-normal"
          >
            <HugeiconsIcon
              icon={CommandIcon}
              strokeWidth={1.5}
              className="size-3.5"
            />
            Actions
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selected"
            onClick={onClear}
            className="size-7 rounded-full text-muted-foreground"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={1.5}
              className="size-4"
            />
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-transparent" />
          <DialogPrimitive.Popup
            finalFocus={trigger}
            className="fixed top-[15vh] left-1/2 z-50 w-[720px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-2xl outline-none"
          >
            <DialogTitle className="sr-only">Label commands</DialogTitle>
            <DialogDescription className="sr-only">
              Choose an action for the selected labels.
            </DialogDescription>
            <Command
              className="rounded-none p-1.5 [&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=input-group]]:h-12! [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:has-[[data-slot=input-group-control]:focus-visible]:ring-0"
              label="Search label commands"
            >
              <div className="flex items-center gap-2 px-2 pt-1.5 pb-1">
                <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {labels.length} {labels.length === 1 ? "label" : "labels"}
                </span>
                {merging && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMerging(false)
                      setSearch("")
                    }}
                    className="h-6 text-xs"
                  >
                    Back to commands
                  </Button>
                )}
              </div>
              <CommandInput
                autoFocus
                aria-label="Search label commands"
                placeholder={
                  merging
                    ? "Choose a label to merge into..."
                    : "Type a command or search..."
                }
                value={search}
                onValueChange={setSearch}
                showSearchIcon={false}
                className="px-2"
              />
              <CommandList className="max-h-[min(360px,60vh)] pt-2 pb-1">
                <CommandEmpty>No commands found.</CommandEmpty>
                {merging ? (
                  <>
                    <p className="px-3 pb-2 text-xs text-muted-foreground">
                      Choose the label to keep. The other selected labels will
                      be combined into it.
                    </p>
                    {labels.map((label) => (
                      <CommandItem
                        key={label.id}
                        value={label.name}
                        onSelect={() => run(() => onMerge(label.id))}
                        className="min-h-11 rounded-md! px-3"
                      >
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: label.color }}
                        />
                        {label.name}
                      </CommandItem>
                    ))}
                  </>
                ) : (
                  <>
                    <CommandItem
                      value={
                        allFavorite
                          ? "Remove favorite labels"
                          : "Favorite labels"
                      }
                      onSelect={() => run(onFavorite)}
                      className="min-h-11 rounded-md! px-3"
                    >
                      <HugeiconsIcon icon={StarIcon} strokeWidth={1.5} />
                      {allFavorite
                        ? "Remove favorite labels"
                        : "Favorite labels"}
                    </CommandItem>
                    {onMove && (
                      <CommandItem
                        value={
                          workspace
                            ? "Move labels to team"
                            : "Move labels to workspace"
                        }
                        onSelect={() => run(onMove)}
                        className="min-h-11 rounded-md! px-3"
                      >
                        <HugeiconsIcon
                          icon={Building02Icon}
                          strokeWidth={1.5}
                        />
                        {workspace
                          ? "Move labels to team..."
                          : "Move labels to workspace..."}
                      </CommandItem>
                    )}
                    <CommandItem
                      value="Merge labels"
                      disabled={labels.length < 2}
                      onSelect={() => {
                        setMerging(true)
                        setSearch("")
                      }}
                      className="min-h-11 rounded-md! px-3"
                    >
                      <HugeiconsIcon
                        icon={PathfinderMergeIcon}
                        strokeWidth={1.5}
                      />
                      Merge labels...
                    </CommandItem>
                    <CommandItem
                      value={
                        allArchived ? "Unarchive labels" : "Archive labels"
                      }
                      onSelect={() => run(onArchive)}
                      className="min-h-11 rounded-md! px-3"
                    >
                      <HugeiconsIcon icon={Archive01Icon} strokeWidth={1.5} />
                      {allArchived
                        ? "Unarchive labels..."
                        : "Archive labels..."}
                    </CommandItem>
                    <CommandItem
                      value="Delete labels"
                      onSelect={() => run(onDelete)}
                      className="min-h-11 rounded-md! px-3"
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.5} />
                      Delete labels...
                    </CommandItem>
                  </>
                )}
              </CommandList>
            </Command>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    </>
  )
}
