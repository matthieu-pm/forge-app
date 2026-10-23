
import * as React from "react"
import { Link } from "@tanstack/react-router"
import {
  InformationCircleIcon,
  SlackIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import type {
  ProjectUpdateSchedule,
  ProjectUpdatesSettings as ProjectUpdatesSettingsValue,
} from "@/lib/project-updates-settings"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  defaultProjectUpdatesSettings,
  readProjectUpdatesSettings,
  writeProjectUpdatesSettings,
} from "@/lib/project-updates-settings"

"use client"

const scheduleOptions: ReadonlyArray<{
  value: ProjectUpdateSchedule
  label: string
}> = [
  { value: "none", label: "No expectation for updates" },
  { value: "1-week", label: "Every week" },
  { value: "2-weeks", label: "Every 2 weeks" },
  { value: "3-weeks", label: "Every 3 weeks" },
  { value: "4-weeks", label: "Every 4 weeks" },
  { value: "5-weeks", label: "Every 5 weeks" },
  { value: "6-weeks", label: "Every 6 weeks" },
  { value: "7-weeks", label: "Every 7 weeks" },
  { value: "8-weeks", label: "Every 8 weeks" },
]

const cardClass =
  "rounded-2xl bg-muted/45 shadow-[0_0_0_1px_rgb(0_0_0/0.03)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.025)]"

function scheduleLabel(schedule: ProjectUpdateSchedule) {
  return (
    scheduleOptions.find((option) => option.value === schedule)?.label ??
    scheduleOptions[0].label
  )
}

export function ProjectUpdatesSettings({
  workspaceId,
}: {
  workspaceId: string
}) {
  const [settings, setSettings] =
    React.useState<ProjectUpdatesSettingsValue>(defaultProjectUpdatesSettings)
  const [draftSchedule, setDraftSchedule] =
    React.useState<ProjectUpdateSchedule>(defaultProjectUpdatesSettings.schedule)
  const [editing, setEditing] = React.useState(false)

  React.useEffect(() => {
    const next = readProjectUpdatesSettings(workspaceId)
    setSettings(next)
    setDraftSchedule(next.schedule)
    setEditing(false)
  }, [workspaceId])

  function beginEditing() {
    setDraftSchedule(settings.schedule)
    setEditing(true)
  }

  function cancelEditing() {
    setDraftSchedule(settings.schedule)
    setEditing(false)
  }

  function saveSchedule() {
    const next = { schedule: draftSchedule }

    try {
      writeProjectUpdatesSettings(workspaceId, next)
      setSettings(next)
      setEditing(false)
      toast.success("Project update schedule saved.")
    } catch {
      toast.error("The project update schedule could not be saved.")
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none px-5 pt-10 pb-16 sm:pt-14">
      <div className="mx-auto w-full max-w-[688px]">
        <header className="px-1">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            Project updates
          </h1>
          <p className="mt-1 max-w-[670px] text-sm leading-6 text-muted-foreground">
            Short status reports about the progress and health of your projects.
            Project members regularly post updates, and subscribers automatically
            receive them in their inbox. {" "}
            <a
              href="https://linear.app/docs/initiative-and-project-updates"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground transition-colors hover:text-foreground/75"
            >
              Docs ↗
            </a>
          </p>
        </header>

        <section aria-labelledby="update-schedule-heading" className="mt-9">
          <div className="px-1">
            <h2
              id="update-schedule-heading"
              className="text-sm font-medium text-foreground"
            >
              Update schedule
            </h2>
            <p className="mt-1 max-w-[650px] text-sm leading-5 text-muted-foreground">
              Configure how often updates are expected on projects. Project leads
              will receive reminders to post updates.
            </p>
          </div>

          <div
            className={`${cardClass} mt-4 flex min-h-14 items-center justify-between gap-4 px-4 py-3 ${editing ? "flex-wrap sm:flex-nowrap" : ""}`}
          >
            {editing ? (
              <>
                <Select
                  value={draftSchedule}
                  onValueChange={(value) => {
                    if (value !== null) setDraftSchedule(value)
                  }}
                >
                  <SelectTrigger
                    aria-label="Project update schedule"
                    className="w-full max-w-full rounded-lg sm:w-fit sm:min-w-[210px]"
                  >
                    <SelectValue>{scheduleLabel(draftSchedule)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    align="start"
                    alignItemWithTrigger={false}
                    className="min-w-[224px] rounded-xl"
                  >
                    {scheduleOptions.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        className="rounded-lg"
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="ml-auto flex w-full items-center justify-end gap-2 sm:w-auto">
                  <Button variant="secondary" onClick={cancelEditing}>
                    Cancel
                  </Button>
                  <Button onClick={saveSchedule}>Save</Button>
                </div>
              </>
            ) : (
              <>
                <p className="min-w-0 truncate text-sm text-foreground">
                  {scheduleLabel(settings.schedule)}
                </p>
                <Button variant="secondary" onClick={beginEditing}>
                  Edit
                </Button>
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="slack-notifications-heading" className="mt-12">
          <div className="px-1">
            <h2
              id="slack-notifications-heading"
              className="text-sm font-medium text-foreground"
            >
              Slack notifications
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Updates are only posted to Slack when associated with at least one
              non-private team
            </p>
          </div>

          <div
            className={`${cardClass} mt-4 flex min-h-[72px] items-center gap-3 px-4 py-3`}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/55 text-muted-foreground">
              <HugeiconsIcon icon={SlackIcon} strokeWidth={1.75} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                #notifications
              </p>
              <p className="truncate text-xs leading-5 text-muted-foreground">
                Broadcasting project updates
              </p>
            </div>
            <button
              type="button"
              aria-label="About Slack project update notifications"
              title="Project updates are broadcast through the workspace Slack integration."
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={1.75}
                className="size-4"
              />
            </button>
            <DropdownMenu>
              <Button
                variant="ghost"
                aria-label="Open Slack connection menu"
                render={<DropdownMenuTrigger />}
                className="gap-2 rounded-lg px-2 font-normal"
              >
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Connected
                <DropdownChevron className="size-3" />
              </Button>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-48">
                <DropdownMenuItem
                  render={<Link to="/settings/applications" />}
                >
                  Manage in Applications
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </section>
      </div>
    </main>
  )
}
