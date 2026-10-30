"use client"

import * as React from "react"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight01Icon,
  SlackIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import { z } from "zod"
import { productStorage } from "@/lib/product-storage"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { projectUpdateScheduleSchema } from "@/lib/project-updates-settings"
import { initiativeLabelsStorageKey, parseTeamLabels } from "@/lib/team-labels"
import { initiativesSettingsStorageKey } from "@/lib/initiatives"

export { initiativesSettingsStorageKey } from "@/lib/initiatives"

const settingsSchema = z.object({
  enabled: z.boolean(),
  schedule: projectUpdateScheduleSchema,
})
type Settings = z.infer<typeof settingsSchema>
const defaults: Settings = { enabled: true, schedule: "none" }
const schedules = projectUpdateScheduleSchema.options
function scheduleLabel(value: Settings["schedule"]) {
  return value === "none"
    ? "No expectation for updates"
    : value === "1-week"
      ? "Every week"
      : `Every ${value.split("-")[0]} weeks`
}
const cardClass = "rounded-xl bg-muted/35 ring-1 ring-border/30"
const copyClass = "mt-1 text-sm leading-[22px] text-muted-foreground"

export function InitiativesSettings({ workspaceId }: { workspaceId: string }) {
  const key = initiativesSettingsStorageKey(workspaceId)
  const [settings, setSettings] = React.useState(defaults)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState("")
  const [labelCount, setLabelCount] = React.useState<number | null>(0)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState<Settings["schedule"]>("none")
  const [slackOpen, setSlackOpen] = React.useState(false)
  React.useEffect(() => {
    function load() {
      try {
        const raw = productStorage.getItem(key)
        setSettings(raw ? settingsSchema.parse(JSON.parse(raw)) : defaults)
        setError("")
      } catch {
        setError(
          "Saved settings could not be loaded. Your saved data has been preserved."
        )
      }
      try {
        const raw = productStorage.getItem(initiativeLabelsStorageKey)
        setLabelCount(
          raw
            ? parseTeamLabels(raw).labels.filter((label) => !label.archived)
                .length
            : 0
        )
      } catch {
        setLabelCount(null)
      }
      setEditing(false)
      setReady(true)
    }
    function onStorage(event: StorageEvent) {
      if (
        event.key === null ||
        event.key === key ||
        event.key === initiativeLabelsStorageKey
      )
        load()
    }
    load()
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [key])
  function save(next: Settings) {
    if (!ready || error) return false
    try {
      productStorage.setItem(key, JSON.stringify(settingsSchema.parse(next)))
      setSettings(next)
      return true
    } catch {
      toast.error("Initiative settings could not be saved. Please try again.")
      return false
    }
  }
  const disabled = !settings.enabled || !ready || !!error
  return (
    <main className="forge-settings-scroll">
      <div className="forge-settings-content">
        <header className="forge-page-header forge-settings-header">
          <h1>Initiatives</h1>
          <p className={copyClass}>
            Initiatives group multiple projects that contribute toward the same
            strategic effort. Use initiatives to plan and coordinate larger
            streams of work and monitor their progress at scale.{" "}
            <a
              href="https://linear.app/docs/initiatives"
              target="_blank"
              rel="noreferrer"
              className="text-foreground hover:underline"
            >
              Docs ↗
            </a>
          </p>
        </header>
        {error && (
          <p role="alert" className="mb-4 px-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <section
          aria-label="Initiative settings"
          className={`${cardClass} flex min-h-16 items-center justify-between gap-4 px-4 py-4`}
        >
          <div>
            <label htmlFor="enable-initiatives" className="text-sm">
              Enable Initiatives
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              Visible to all non-guest workspace members
            </p>
          </div>
          <Switch
            id="enable-initiatives"
            checked={settings.enabled}
            disabled={!ready || !!error}
            onCheckedChange={(enabled) => {
              if (save({ ...settings, enabled })) {
                setEditing(false)
                setSlackOpen(false)
              }
            }}
            className="shrink-0 data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-unchecked:bg-muted-foreground/60 [&_[data-slot=switch-thumb]]:bg-white"
          />
        </section>
        <fieldset
          disabled={disabled}
          className={`mt-12 min-w-0 space-y-12 border-0 p-0 ${disabled ? "opacity-40" : ""}`}
        >
          <legend className="sr-only">Initiative configuration</legend>
          <section aria-labelledby="initiative-updates-heading">
            <div className="px-4">
              <h2
                id="initiative-updates-heading"
                className="text-base font-medium"
              >
                Initiative updates
              </h2>
              <p className={copyClass}>
                Short status reports about the progress and health of your
                initiative. Updates are ideally written regularly by the owner
                of the initiative. Subscribers receive these updates directly in
                their inbox. You can also configure a Slack channel where all
                initiative updates are posted.
              </p>
              <h3 className="mt-4 text-sm font-medium">Update schedule</h3>
              <p className={copyClass}>
                Configure how often updates are expected on initiatives.
                Initiative owners will receive reminders to post updates.
              </p>
            </div>
            <div
              className={`${cardClass} mt-3 flex min-h-12 flex-wrap items-center justify-between gap-3 px-4 py-3`}
            >
              {editing ? (
                <>
                  <Select
                    value={draft}
                    onValueChange={(value) => {
                      if (value) setDraft(value)
                    }}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      aria-label="Initiative update schedule"
                      className="w-full sm:w-56"
                    >
                      <SelectValue>{scheduleLabel(draft)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {schedules.map((value) => (
                        <SelectItem key={value} value={value}>
                          {scheduleLabel(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="ml-auto flex gap-2">
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => {
                        if (save({ ...settings, schedule: draft }))
                          setEditing(false)
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm">{scheduleLabel(settings.schedule)}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-full px-2 text-xs font-normal"
                    disabled={disabled}
                    onClick={() => {
                      setDraft(settings.schedule)
                      setEditing(true)
                    }}
                  >
                    Edit
                  </Button>
                </>
              )}
            </div>
          </section>
          <section aria-labelledby="initiative-slack-heading">
            <div className="px-4">
              <h2 id="initiative-slack-heading" className="text-sm font-medium">
                Slack notifications
              </h2>
              <p className={copyClass}>
                Updates are only posted to Slack for workspace-level initiatives
                or initiatives led by a public team
              </p>
            </div>
            <div
              className={`${cardClass} mt-3 flex min-h-16 flex-wrap items-center gap-3 px-4 py-4`}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/50">
                <HugeiconsIcon
                  icon={SlackIcon}
                  className="size-4 text-muted-foreground"
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">Slack</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  Broadcasting initiative updates
                </p>
              </div>
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => setSlackOpen(true)}
                size="default"
                className="rounded-full px-2 font-normal"
              >
                Connect
              </Button>
            </div>
          </section>
          <section aria-labelledby="initiative-labels-heading">
            <h2
              id="initiative-labels-heading"
              className="px-4 text-base font-medium"
            >
              Labels
            </h2>
            <Link
              to="/settings/initiative-labels"
              aria-label="Initiative labels settings"
              aria-disabled={disabled}
              tabIndex={disabled ? -1 : undefined}
              onClick={(event) => {
                if (disabled) event.preventDefault()
              }}
              className={`${cardClass} mt-4 flex min-h-16 items-center gap-3 px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring ${disabled ? "cursor-default" : "hover:bg-muted/50"}`}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/50">
                <HugeiconsIcon
                  icon={Tag01Icon}
                  className="size-4 text-muted-foreground"
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">Initiative labels</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  Manage the labels that can be applied to initiatives in your
                  workspace
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {labelCount === null
                  ? "—"
                  : `${labelCount} ${labelCount === 1 ? "label" : "labels"}`}
              </span>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Link>
          </section>
        </fieldset>
      </div>
      <Dialog open={slackOpen && !disabled} onOpenChange={setSlackOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Slack notifications</DialogTitle>
            <DialogDescription>
              Slack broadcasting for initiative updates is not connected yet. No
              updates will be sent until a workspace Slack integration is
              available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setSlackOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
