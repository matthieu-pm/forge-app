"use client"

import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Calendar03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamCyclesSettings as CyclePreferences } from "@/lib/team-cycles"
import { cycleWeekdays, nextCycleStart, useTeamCycles } from "@/lib/team-cycles"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const cardClass = "rounded-xl bg-muted/35 px-4 ring-1 ring-border/30"
const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const weekOptions = (values: Array<number>) =>
  values.map((value) => ({
    value,
    label:
      value === 0
        ? "No cooldown"
        : `${value} ${value === 1 ? "week" : "weeks"}`,
  }))
const durations = weekOptions([1, 2, 3, 4, 5, 6, 7, 8])
const cooldowns = weekOptions([0, 1, 2, 3, 4])
const weekdays = [1, 2, 3, 4, 5, 6, 0].map((value) => ({
  value,
  label: cycleWeekdays[value],
}))
const futureCounts = [1, 2, 3, 4, 5, 6].map((value) => ({
  value,
  label: `${value} ${value === 1 ? "cycle" : "cycles"}`,
}))

function CycleToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description?: ReactNode
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  const id = React.useId()
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 py-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {description && (
          <p
            id={`${id}-description`}
            className="mt-0.5 text-xs leading-4 text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={description ? `${id}-description` : undefined}
        className="mr-1 transition-[background-color,border-color] duration-150 motion-reduce:transition-none data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-unchecked:bg-muted-foreground/60 data-disabled:border-transparent data-disabled:bg-muted-foreground/40 data-checked:data-disabled:border-transparent data-checked:data-disabled:bg-muted-foreground/40 [&_[data-slot=switch-thumb]]:bg-white [&_[data-slot=switch-thumb]]:duration-150 [&_[data-slot=switch-thumb]]:motion-reduce:transition-none"
      />
    </div>
  )
}

function CycleChoice({
  label,
  description,
  value,
  options,
  disabled,
  calendar,
  onChange,
}: {
  label: string
  description?: string
  value: number
  options: Array<{ value: number; label: string }>
  disabled: boolean
  calendar?: boolean
  onChange: (value: number) => void
}) {
  const id = React.useId()
  return (
    <div className="flex min-h-16 flex-col justify-center gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div>
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {description && (
          <p
            id={`${id}-description`}
            className="mt-0.5 text-xs leading-4 text-muted-foreground"
          >
            {description}
          </p>
        )}
      </div>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next)
        }}
      >
        <SelectTrigger
          id={id}
          aria-label={label}
          aria-describedby={description ? `${id}-description` : undefined}
          className={`h-8 w-full shrink-0 rounded-lg border-border/40 bg-muted/60 px-2.5 font-normal sm:w-[212px] ${calendar ? "[&>svg]:hidden" : ""}`}
        >
          <SelectValue>
            {options.find((option) => option.value === value)?.label}
          </SelectValue>
          {calendar && (
            <span aria-hidden="true">
              <HugeiconsIcon
                icon={Calendar03Icon}
                className="size-4"
                strokeWidth={1.5}
              />
            </span>
          )}
        </SelectTrigger>
        <SelectContent
          align="end"
          alignItemWithTrigger={false}
          className="rounded-xl p-1 motion-reduce:animate-none"
        >
          {options.map((option) => (
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
    </div>
  )
}

export function TeamCyclesSettings({ team }: { team: TeamSummary }) {
  const {
    settings,
    ready,
    error,
    update,
    pending,
    canManage,
    cycles,
    retry,
    discard,
  } = useTeamCycles(team.id)
  const disabled = !ready || !!error || pending || !canManage
  const nextStart = (
    cycles.find((c) => c.state === "Upcoming")?.start ??
    nextCycleStart(settings.startDay)
  ).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  async function save(patch: Partial<CyclePreferences>) {
    if (!(await update(patch)))
      toast.error("Your cycle settings could not be saved. Please try again.")
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="forge-settings-scroll">
        <div className="forge-settings-content">
          <header className="forge-page-header forge-settings-header">
            <h1>Cycles</h1>
            <p className="mt-1.5 text-sm leading-[22px] text-muted-foreground">
              Plan shared work in fixed cycle windows. Existing dates stay fixed
              when you change the schedule. New settings apply to newly created
              cycles.{" "}
              <a
                href="https://linear.app/docs/use-cycles"
                target="_blank"
                rel="noreferrer"
                aria-label="Cycles documentation (opens in a new tab)"
                className={`rounded-sm whitespace-nowrap text-foreground underline-offset-4 hover:underline ${focusClass}`}
              >
                Docs ↗
              </a>
            </p>
          </header>
          {error && (
            <p role="alert" className="mb-4 px-4 text-sm text-destructive">
              {error}
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void retry()}
              >
                Retry saved change
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={discard}
              >
                Discard saved change
              </Button>
            </p>
          )}
          {pending && (
            <p role="status" className="mb-4 text-sm text-muted-foreground">
              Saving cycle settings…
            </p>
          )}
          {ready && !canManage && (
            <p className="mb-4 text-sm text-muted-foreground">
              Workspace admins manage cycle settings. Members can plan issues in
              existing cycles.
            </p>
          )}
          <section aria-label="Cycle settings" className="space-y-3">
            <div className={cardClass}>
              <CycleToggle
                label="Enable cycles"
                checked={settings.enabled}
                disabled={disabled}
                onChange={(enabled) => save({ enabled })}
                description={
                  settings.enabled ? (
                    <>
                      For more meaningful cycle velocity metrics, enable
                      estimates in{" "}
                      <Link
                        to="/settings/teams/$teamSlug/general"
                        params={{ teamSlug: team.slug }}
                        className={`rounded-sm text-foreground hover:underline ${focusClass}`}
                      >
                        team settings
                      </Link>
                    </>
                  ) : undefined
                }
              />
            </div>
            {settings.enabled && (
              <div className={`${cardClass} divide-y divide-border/40`}>
                <div className="flex min-h-16 items-center justify-between gap-4 py-4">
                  <label htmlFor="cycle-timezone" className="text-sm">
                    Timezone for new cycles
                  </label>
                  <Input
                    id="cycle-timezone"
                    aria-label="Cycle timezone"
                    className="w-56"
                    disabled={disabled}
                    defaultValue={settings.timezone ?? "UTC"}
                    key={settings.timezone}
                    onBlur={(event) => {
                      if (event.target.value !== settings.timezone)
                        void save({ timezone: event.target.value })
                    }}
                  />
                </div>
                <CycleChoice
                  label="Cycle duration"
                  value={settings.duration}
                  options={durations}
                  disabled={disabled}
                  onChange={(duration) => save({ duration })}
                />
                <CycleChoice
                  label="Cooldown duration"
                  value={settings.cooldown}
                  options={cooldowns}
                  disabled={disabled}
                  onChange={(cooldown) => save({ cooldown })}
                />
                <CycleChoice
                  label="Cycle start"
                  description={`Next cycle begins ${nextStart}`}
                  calendar
                  value={settings.startDay}
                  options={weekdays}
                  disabled={disabled}
                  onChange={(startDay) => save({ startDay })}
                />
                <CycleChoice
                  label="Upcoming cycles"
                  value={settings.futureCycles}
                  options={futureCounts}
                  disabled={disabled}
                  onChange={(futureCycles) => save({ futureCycles })}
                />
              </div>
            )}
          </section>
          <section
            aria-labelledby="cycle-automation-title"
            className={`mt-6 ${!settings.enabled ? "opacity-45" : ""}`}
          >
            <div className="mb-3 px-4">
              <h2 id="cycle-automation-title" className="text-sm">
                Cycle automation
              </h2>
              <p className="mt-1 text-sm leading-[22px] text-muted-foreground">
                Automatic assignment and carryover are not available yet.
              </p>
            </div>
            <div className={`${cardClass} divide-y divide-border/40`}>
              <CycleToggle
                label="Active issues & due date"
                description="Auto-add started, unstarted, and issues with due dates that match the current cycle, or the next if in cooldown"
                checked={settings.activeIssues}
                disabled={true}
                onChange={(activeIssues) => save({ activeIssues })}
              />
              <CycleToggle
                label="Started issues"
                description="Auto-add started issues to the current cycle, or the next if in cooldown"
                checked={settings.startedIssues}
                disabled={true}
                onChange={(startedIssues) => save({ startedIssues })}
              />
              <CycleToggle
                label="Completed issues"
                description="Auto-add completed issues to the current cycle, or the next if in cooldown"
                checked={settings.completedIssues}
                disabled={true}
                onChange={(completedIssues) => save({ completedIssues })}
              />
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
