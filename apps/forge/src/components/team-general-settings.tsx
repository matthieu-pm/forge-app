import * as React from "react"
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import type { TeamSummary, UpdateTeamInput } from "@/lib/team-contract"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { TeamTimezonePicker } from "@/components/team-timezone-picker"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { notifyTeamDirectoryChanged } from "@/lib/team-events"
import { updateTeam } from "@/lib/team-state"
import { cn } from "@/lib/utils"

;

("use client")

type TeamSettings = UpdateTeamInput["settings"]
type SaveStatus = "idle" | "saving" | "saved" | "error"

const estimationOptions = [
  { value: "none", label: "Not in use" },
  { value: "exponential", label: "Exponential (1, 2, 4, 8, 16 Points)" },
  { value: "fibonacci", label: "Fibonacci (1, 2, 3, 5, 8 Points)" },
  { value: "linear", label: "Linear (1, 2, 3, 4, 5 Points)" },
  { value: "tshirt", label: "T-Shirt (XS, S, M, L, XL)" },
] as const

function FieldRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description?: string
  label: string
}) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function SectionHeading({
  children,
  docs,
  title,
}: {
  children: React.ReactNode
  docs?: boolean
  title: string
}) {
  return (
    <div className="space-y-1 px-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-sm leading-5 text-muted-foreground">
        {children}
        {docs ? (
          <span className="ml-1 whitespace-nowrap text-foreground">Docs ↗</span>
        ) : null}
      </p>
    </div>
  )
}

function SettingsCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border/70 bg-muted/35",
        className
      )}
    >
      {children}
    </div>
  )
}

export function TeamGeneralSettings({ team }: { team: TeamSummary }) {
  const [icon, setIcon] = React.useState(team.icon)
  const [name, setName] = React.useState(team.name)
  const [identifier, setIdentifier] = React.useState(team.identifier)
  const [description, setDescription] = React.useState(team.description)
  const [timezone, setTimezone] = React.useState(team.timezone)
  const [estimationScheme, setEstimationScheme] = React.useState(
    team.estimationScheme
  )
  const [issueEmailEnabled, setIssueEmailEnabled] = React.useState(
    team.issueEmailEnabled
  )
  const [detailedHistoryEnabled, setDetailedHistoryEnabled] = React.useState(
    team.detailedHistoryEnabled
  )
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("idle")
  const savedSettings = React.useRef({
    icon: team.icon,
    name: team.name,
    identifier: team.identifier,
    description: team.description,
    timezone: team.timezone,
    estimationScheme: team.estimationScheme,
    issueEmailEnabled: team.issueEmailEnabled,
    detailedHistoryEnabled: team.detailedHistoryEnabled,
  })
  const saveSequence = React.useRef(0)

  async function saveSettings(settings: TeamSettings) {
    const sequence = ++saveSequence.current
    setSaveStatus("saving")

    try {
      const result = await updateTeam({
        data: { slug: team.slug, settings },
      })

      if (!result.ok) {
        setSaveStatus("error")
        toast.error(result.message)
        return false
      }

      Object.assign(savedSettings.current, settings)
      notifyTeamDirectoryChanged()
      if (sequence === saveSequence.current) {
        setSaveStatus("saved")
        window.setTimeout(() => {
          if (sequence === saveSequence.current) setSaveStatus("idle")
        }, 1600)
      }
      return true
    } catch {
      setSaveStatus("error")
      toast.error("The team settings could not be saved. Try again.")
      return false
    }
  }

  function saveChangedSetting<TKey extends keyof typeof savedSettings.current>(
    key: TKey,
    value: (typeof savedSettings.current)[TKey]
  ) {
    if (savedSettings.current[key] === value) return
    void saveSettings({ [key]: value })
  }

  const saveStatusLabel = {
    idle: "",
    saving: "Saving…",
    saved: "Saved",
    error: "Not saved",
  }[saveStatus]
  const selectedEstimation =
    estimationOptions.find((option) => option.value === estimationScheme) ??
    estimationOptions[0]

  return (
    <main className="forge-settings-scroll">
      <div className="forge-page-back flex h-12 shrink-0 items-center px-4">
        <Link
          to="/settings/teams/$teamSlug"
          params={{ teamSlug: team.slug }}
          className="inline-flex items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            strokeWidth={2}
            className="size-3.5"
          />
          <TeamSidebarIcon icon={icon} name={team.name} />
          {name}
        </Link>
      </div>

      <div className="forge-settings-content">
        <div className="space-y-12">
          <div className="forge-page-header forge-settings-header flex items-center justify-between gap-4">
            <h1>General</h1>
            <span
              aria-live="polite"
              className={cn(
                "text-xs text-muted-foreground transition-opacity",
                !saveStatusLabel && "opacity-0",
                saveStatus === "error" && "text-destructive"
              )}
            >
              {saveStatusLabel || "Saved"}
            </span>
          </div>
          <section className="space-y-5">
            <SettingsCard>
              <FieldRow label="Icon & Name">
                <TeamIconPicker
                  name={name}
                  value={icon}
                  onChange={(nextIcon) => {
                    setIcon(nextIcon)
                    void saveSettings({ icon: nextIcon })
                  }}
                />
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => saveChangedSetting("name", name.trim())}
                  maxLength={80}
                  aria-label="Team name"
                  className="h-8 w-48 rounded-lg border-border/60 bg-background/60"
                />
              </FieldRow>
              <div className="border-t border-border/60">
                <FieldRow label="Identifier" description="Used in issue IDs">
                  <Input
                    value={identifier}
                    onChange={(event) =>
                      setIdentifier(
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, "")
                          .slice(0, 5)
                      )
                    }
                    onBlur={() => saveChangedSetting("identifier", identifier)}
                    maxLength={5}
                    aria-label="Team identifier"
                    className="h-8 w-48 rounded-lg border-border/60 bg-background/60"
                  />
                </FieldRow>
              </div>
            </SettingsCard>
          </section>

          <section className="space-y-3">
            <SectionHeading title="Description">
              A short summary shown on the team page
            </SectionHeading>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() =>
                saveChangedSetting("description", description.trim())
              }
              maxLength={500}
              aria-label="Team description"
              placeholder="e.g. Builds and maintains core platform infrastructure"
              className="min-h-28 rounded-2xl border-border/70 bg-muted/35 px-4 py-3"
            />
          </section>

          <section className="space-y-3">
            <SectionHeading title="Timezone">
              Used for team schedules, dates, and cycle start times
            </SectionHeading>
            <SettingsCard>
              <FieldRow label="Timezone">
                <TeamTimezonePicker
                  value={timezone}
                  onValueChange={(value) => {
                    setTimezone(value)
                    void saveSettings({ timezone: value })
                  }}
                />
              </FieldRow>
            </SettingsCard>
          </section>

          <section className="space-y-3">
            <SectionHeading title="Estimates" docs>
              Used to estimate issue complexity and plan cycle capacity.
            </SectionHeading>
            <SettingsCard>
              <FieldRow label="Issue estimation">
                <DropdownMenu>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Issue estimation"
                    render={<DropdownMenuTrigger />}
                    className="group rounded-lg font-normal"
                  >
                    <span>{selectedEstimation.label}</span>
                    <DropdownChevron className="size-3.5" />
                  </Button>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    className="w-max min-w-[290px]"
                  >
                    <DropdownMenuRadioGroup
                      value={estimationScheme}
                      onValueChange={(value) => {
                        const nextValue =
                          value as TeamSummary["estimationScheme"]
                        setEstimationScheme(nextValue)
                        void saveSettings({ estimationScheme: nextValue })
                      }}
                    >
                      {estimationOptions.map((option) => (
                        <DropdownMenuRadioItem
                          key={option.value}
                          value={option.value}
                        >
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </FieldRow>
            </SettingsCard>
          </section>

          <section className="space-y-3">
            <SectionHeading title="Create issues by email">
              Use a team-specific email address to create and collaborate on
              issues via email
            </SectionHeading>
            <SettingsCard>
              <FieldRow label="Enable issue creation by email">
                <Switch
                  checked={issueEmailEnabled}
                  onCheckedChange={(checked) => {
                    setIssueEmailEnabled(checked)
                    void saveSettings({ issueEmailEnabled: checked })
                  }}
                  aria-label="Enable issue creation by email"
                />
              </FieldRow>
            </SettingsCard>
          </section>

          <section className="space-y-3">
            <SectionHeading title="Other">Team-level behavior</SectionHeading>
            <SettingsCard>
              <FieldRow
                label="Enable detailed issue history"
                description="Each change receives a distinct history entry, creating a more detailed history for auditing purposes."
              >
                <Switch
                  checked={detailedHistoryEnabled}
                  onCheckedChange={(checked) => {
                    setDetailedHistoryEnabled(checked)
                    void saveSettings({ detailedHistoryEnabled: checked })
                  }}
                  aria-label="Enable detailed issue history"
                />
              </FieldRow>
            </SettingsCard>
          </section>
        </div>
      </div>
    </main>
  )
}
