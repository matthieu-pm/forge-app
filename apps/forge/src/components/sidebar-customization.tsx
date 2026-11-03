import * as React from "react"
import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useFeatureNavigation } from "./feature-availability"
import {
  PreferenceSyncStatus,
  usePreferenceGroup,
} from "./account-preference-provider"
import { Button } from "./ui/button"
import { Switch } from "./ui/switch"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog"
import type {
  SidebarGroup,
  SidebarLayout,
} from "@/lib/sidebar-preference-contract"
import {
  defaultSidebarLayout,
  reconcileSidebarLayout,
  replaceSidebarGroup,
  sidebarBadgeStyleSchema,
} from "@/lib/sidebar-preference-contract"

export function SidebarCustomization() {
  const sync = usePreferenceGroup("general")
  const available = useFeatureNavigation()
  const [announcement, announce] = React.useState("")
  const [error, setError] = React.useState("")
  const root = React.useRef<HTMLDivElement>(null)
  const reset = React.useRef<HTMLButtonElement>(null)
  const focusedControl = React.useRef<HTMLElement | null>(null)
  const layout = reconcileSidebarLayout(
    sync.preferences.sidebarLayout,
    (item) => available(item.to)
  )

  function save(patch: Partial<typeof sync.preferences>, message: string) {
    if (!sync.editable) return
    try {
      sync.update({ ...sync.preferences, ...patch })
      setError("")
      announce(message)
    } catch {
      setError("Your sidebar changes could not be applied. Try again.")
    }
  }

  function move(id: string, group: SidebarGroup, offset: -1 | 1) {
    const items = layout.filter((item) => item.group === group)
    const index = items.findIndex((item) => item.id === id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= items.length || !sync.editable)
      return
    const [item] = items.splice(index, 1)
    items.splice(target, 0, item)
    // Keep temporarily unavailable destinations in the stored group, never in UI.
    let visibleIndex = 0
    const next: SidebarLayout = reconcileSidebarLayout(
      sync.preferences.sidebarLayout
    )
      .filter((entry) => entry.group === group)
      .map((entry) => {
        // Keep unavailable destinations in their original slots while reordering
        // the visible subset. A later rollout restores their previous position.
        const nextItem = available(entry.to) ? items[visibleIndex++] : entry
        return { id: nextItem.id, visible: nextItem.visible }
      })
    save(
      {
        sidebarLayout: replaceSidebarGroup(
          sync.preferences.sidebarLayout,
          group,
          next
        ),
      },
      `${item.title} moved to position ${target + 1} of ${items.length} in ${group === "primary" ? "Main navigation" : "Workspace"}.`
    )
  }

  // A gate refresh can remove the currently focused row. Move focus to a stable
  // editor action after reconciliation instead of leaving focus on the page.
  const availableIds = layout.map((item) => item.id).join(",")
  React.useLayoutEffect(() => {
    const control = focusedControl.current
    if (!root.current || !control) return
    if (!control.isConnected) reset.current?.focus()
    else if (document.activeElement === document.body) control.focus()
  }, [availableIds])

  return (
    <Dialog>
      <Button
        variant="ghost"
        size="sm"
        disabled={!sync.editable}
        render={<DialogTrigger />}
        className="rounded-lg px-2.5 text-xs"
      >
        Customize
      </Button>
      <DialogContent
        ref={root}
        onFocusCapture={(event) => {
          focusedControl.current = event.target as HTMLElement
        }}
        className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto p-4 motion-reduce:animate-none sm:max-w-lg sm:p-6"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>Customize sidebar</DialogTitle>
          <DialogDescription>
            Changes apply immediately and save to your account. Reorder items
            within each group with the arrow buttons or Alt + Up / Down.
          </DialogDescription>
        </DialogHeader>
        <PreferenceSyncStatus />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {announcement}
        </p>
        {(["primary", "workspace"] as const).map((group) => {
          const items = layout.filter((item) => item.group === group)
          return (
            <section
              key={group}
              aria-label={group === "primary" ? "Main navigation" : "Workspace"}
              className="space-y-2"
            >
              <h3 className="text-xs font-medium text-muted-foreground">
                {group === "primary" ? "Main navigation" : "Workspace"}
              </h3>
              <ol className="divide-y rounded-xl border px-2">
                {items.map((item, index) => (
                  <li
                    key={item.id}
                    data-sidebar-destination={item.id}
                    className="flex min-w-0 items-center gap-2 py-2"
                    onKeyDown={(event) => {
                      if (
                        event.altKey &&
                        (event.key === "ArrowUp" || event.key === "ArrowDown")
                      ) {
                        event.preventDefault()
                        move(item.id, group, event.key === "ArrowUp" ? -1 : 1)
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 text-sm">
                      {item.title}
                      {"required" in item && (
                        <span className="block text-xs text-muted-foreground">
                          Always shown
                        </span>
                      )}
                    </span>
                    <Button
                      static
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${item.title} up`}
                      className="aria-disabled:opacity-40"
                      aria-disabled={!sync.editable || index === 0}
                      onClick={() => move(item.id, group, -1)}
                    >
                      <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
                    </Button>
                    <Button
                      static
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${item.title} down`}
                      className="aria-disabled:opacity-40"
                      aria-disabled={
                        !sync.editable || index === items.length - 1
                      }
                      onClick={() => move(item.id, group, 1)}
                    >
                      <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                    </Button>
                    <Switch
                      aria-label={`Show ${item.title}`}
                      checked={item.visible}
                      disabled={!sync.editable || "required" in item}
                      onCheckedChange={(visible) => {
                        const next = reconcileSidebarLayout(
                          sync.preferences.sidebarLayout
                        ).map((entry) => ({
                          id: entry.id,
                          visible:
                            entry.id === item.id ? visible : entry.visible,
                        }))
                        save(
                          { sidebarLayout: next },
                          `${item.title} ${visible ? "shown" : "hidden"} in sidebar.`
                        )
                      }}
                    />
                  </li>
                ))}
              </ol>
            </section>
          )
        })}
        <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
          Sidebar badge style
          <select
            aria-label="Sidebar badge style"
            className="h-8 rounded-lg border bg-popover px-2 text-sm"
            disabled={!sync.editable}
            value={sync.preferences.sidebarBadgeStyle}
            onChange={(event) => {
              const value = sidebarBadgeStyleSchema.parse(event.target.value)
              save(
                { sidebarBadgeStyle: value },
                `Sidebar badge style: ${value}.`
              )
            }}
          >
            <option value="count">Count</option>
            <option value="dot">Dot</option>
            <option value="off">Off</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Applies to unread Inbox notifications. The app-icon / native dock
          badge is set separately. Inbox and Settings stay reachable; team
          navigation and favorites keep their own controls.
        </p>
        <DialogFooter className="flex-row flex-wrap justify-between sm:justify-between">
          <Button
            ref={reset}
            variant="outline"
            disabled={!sync.editable}
            onClick={() =>
              save(
                {
                  sidebarLayout: defaultSidebarLayout,
                  sidebarBadgeStyle: "count",
                },
                "Default sidebar restored. All available destinations are shown in their default order, with count badges."
              )
            }
          >
            Reset to defaults
          </Button>
          <DialogClose render={<Button variant="secondary" />}>
            Done
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
