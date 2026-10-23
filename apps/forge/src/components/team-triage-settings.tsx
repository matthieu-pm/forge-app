"use client"

import * as React from "react"
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  LinkCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamTriageSettings as TriagePreferences } from "@/lib/team-triage"
import { useTeamTriage } from "@/lib/team-triage"
import { TriageResponsibilityDialog } from "@/components/triage-responsibility-dialog"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const cardClass = "rounded-xl bg-muted/35 px-4 ring-1 ring-border/30"
const textLinkClass = `rounded-sm text-foreground underline-offset-4 hover:underline ${focusClass}`

function TriageToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const id = React.useId()
  return (
    <div
      className={`flex min-h-16 items-center justify-between gap-6 py-4 ${disabled ? "opacity-45" : ""}`}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        <p
          id={`${id}-description`}
          className="mt-0.5 text-xs leading-4 text-muted-foreground"
        >
          {description}
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-description`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="mr-1 transition-[background-color,border-color] duration-150 data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-unchecked:bg-muted-foreground/60 data-disabled:opacity-100 [&_[data-slot=switch-thumb]]:bg-white [&_[data-slot=switch-thumb]]:motion-reduce:transition-none"
      />
    </div>
  )
}
function SectionHeading({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="mb-4 px-4">
      <h2 className="text-base font-medium">{title}</h2>
      {children && (
        <p className="mt-1 text-sm leading-[22px] text-muted-foreground">
          {children}
        </p>
      )}
    </div>
  )
}
function DocsLink({ topic }: { topic: "triage" | "triage-intelligence" }) {
  return (
    <a
      href={`https://linear.app/docs/${topic}`}
      target="_blank"
      rel="noreferrer"
      aria-label={
        topic === "triage"
          ? "Triage documentation (opens in a new tab)"
          : "Triage Intelligence documentation (opens in a new tab)"
      }
      className={`whitespace-nowrap ${textLinkClass}`}
    >
      Docs ↗
    </a>
  )
}

export function TeamTriageSettings({ team }: { team: TeamSummary }) {
  const { settings, ready, error, update } = useTeamTriage(team.id)
  const [dialog, setDialog] = React.useState<"loops" | null>(null)
  const [responsibilityOpen, setResponsibilityOpen] = React.useState(false)
  const disabled = !ready || !!error
  function save(patch: Partial<TriagePreferences>) {
    if (!update(patch))
      toast.error("Your triage settings could not be saved. Please try again.")
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center px-4">
        <Link
          to="/settings/teams/$teamSlug"
          params={{ teamSlug: team.slug }}
          aria-label={`Back to ${team.name} settings`}
          className={`inline-flex items-center gap-2 rounded-md py-1 text-sm text-muted-foreground hover:text-foreground ${focusClass}`}
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            className="size-4"
            strokeWidth={1.5}
          />
          <TeamSidebarIcon
            icon={team.icon}
            name={team.name}
            className="size-4"
          />
          {team.name}
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-none pb-16">
        <div className="mx-auto w-full max-w-[688px] px-4 pt-5 sm:px-6">
          <header className="px-4 pb-8">
            <h1 className="text-2xl font-medium tracking-tight">Triage</h1>
            <p className="mt-1.5 text-sm leading-[22px] text-muted-foreground">
              Triage is a special inbox for managing issues created by
              integrations and members outside of this team. You’ll have a
              chance to review, accept or reject, and prioritize issues before
              they’re added to your team’s workflow. <DocsLink topic="triage" />
            </p>
          </header>
          {error && (
            <p role="alert" className="mb-4 px-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="space-y-12">
            <section aria-label="Triage settings" className={cardClass}>
              <TriageToggle
                label="Enable triage for this team"
                description="Issues added to this team by outside members are sent to the triage inbox first"
                checked={settings.enabled}
                disabled={disabled}
                onChange={(enabled) => save({ enabled })}
              />
              <div className="border-t border-border/40">
                <TriageToggle
                  label="Require explicit prioritization"
                  description="Require that a priority has to be set when moving issues out of triage"
                  checked={settings.requirePriority}
                  disabled={disabled || !settings.enabled}
                  onChange={(requirePriority) => save({ requirePriority })}
                />
              </div>
            </section>
            <section aria-label="Triage responsibility">
              <SectionHeading title="Triage responsibility" />
              <div
                className={`${cardClass} flex flex-col items-start justify-between gap-4 py-4 sm:flex-row sm:items-center sm:gap-6`}
              >
                <div className="min-w-0">
                  <p className="text-sm">
                    Define how incoming issues and requests are handled in
                    triage
                  </p>
                  <p className="mt-0.5 text-xs leading-[18px] text-muted-foreground">
                    Configure the action for new triage issues.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="default"
                  className="shrink-0 rounded-full px-3 font-normal"
                  disabled={disabled || !settings.enabled}
                  onClick={() => setResponsibilityOpen(true)}
                >
                  Configure
                </Button>
              </div>
            </section>
            <section aria-label="Agent automations">
              <SectionHeading title="Agent automations">
                Automations have been renamed to Loops and moved to the team
                page
              </SectionHeading>
              <button
                type="button"
                aria-label="Loops settings"
                onClick={() => setDialog("loops")}
                className={`${cardClass} flex min-h-16 w-full items-center gap-3 py-4 text-left transition-colors duration-150 hover:bg-muted/50 ${focusClass}`}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/35 text-muted-foreground">
                  <HugeiconsIcon
                    icon={LinkCircleIcon}
                    className="size-4"
                    strokeWidth={1.5}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">Loops</span>
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    Loops acting on issues in triage for this team
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  0 loops
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  className="size-4 shrink-0 text-muted-foreground"
                  strokeWidth={1.5}
                />
              </button>
            </section>
            <section
              aria-label="Triage Intelligence"
              className={!settings.enabled ? "opacity-55" : undefined}
            >
              <SectionHeading title="Triage Intelligence">
                Forge uses agentic AI to automatically find related issues &amp;
                duplicates, and infer properties like team, project, labels, and
                assignee. <DocsLink topic="triage-intelligence" />
              </SectionHeading>
              <div
                className={`${cardClass} flex min-h-16 flex-col justify-center gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6`}
              >
                <p className="text-sm text-muted-foreground">
                  Triage Intelligence is not enabled in this workspace
                </p>
                <Link
                  to="/settings/ai"
                  className={`shrink-0 self-start rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground sm:self-auto ${focusClass}`}
                >
                  View settings
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Loops</DialogTitle>
            <DialogDescription>
              No loops are configured for {team.name}.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-6 text-muted-foreground">
            Loops for triage aren’t available in Forge yet.
          </p>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TriageResponsibilityDialog
        teamId={team.id}
        open={responsibilityOpen}
        onOpenChange={setResponsibilityOpen}
      />
    </main>
  )
}
