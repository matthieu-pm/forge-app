"use client"

import {
  AiMagicIcon,
  ArrowRight01Icon,
  Calendar03Icon,
  Clock04Icon,
  Cursor02Icon,
  Delete02Icon,
  FilePasteIcon,
  InboxCheckIcon,
  Progress03Icon,
  Settings02Icon,
  SlackIcon,
  SquareActivity,
  Summation01Icon,
  Tag01Icon,
  UserGroup03Icon,
  WorkflowSquare03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouter } from "@tanstack/react-router"
import * as React from "react"
import { toast } from "sonner"
import type { ComponentProps, ReactNode } from "react"

import type { TeamSummary } from "@/lib/team-contract"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { deleteTeam } from "@/lib/team-state"
import { cn } from "@/lib/utils"

type SettingsIcon = ComponentProps<typeof HugeiconsIcon>["icon"]

type SettingItem = {
  description: string
  icon: SettingsIcon
  label: string
  section?: "general"
  value?: string
}

const overviewItems: Array<SettingItem> = [
  {
    label: "General",
    description: "Name, identifier, timezone, estimates, and broader settings",
    icon: Settings02Icon,
    section: "general",
  },
  {
    label: "Members",
    description: "Manage team members",
    icon: UserGroup03Icon,
    value: "1 member",
  },
  {
    label: "Slack notifications",
    description: "Broadcast notifications to Slack",
    icon: SlackIcon,
    value: "Off",
  },
]

const issueItems: Array<SettingItem> = [
  {
    label: "Issue labels",
    description: "Labels available to this team's issues",
    icon: Tag01Icon,
    value: "None",
  },
  {
    label: "Templates",
    description: "Pre-filled templates for issues, documents, and projects",
    icon: FilePasteIcon,
    value: "None",
  },
  {
    label: "Recurring issues",
    description: "Automatically create issues on a schedule",
    icon: Calendar03Icon,
    value: "None",
  },
]

const workflowItems: Array<SettingItem> = [
  {
    label: "Issue statuses",
    description: "Customize the statuses issues go through",
    icon: Progress03Icon,
    value: "7 statuses",
  },
  {
    label: "Workflows & automations",
    description: "Manage issue automations, git workflows and other workflows",
    icon: WorkflowSquare03Icon,
  },
  {
    label: "Triage",
    description: "Streamline how you handle requests from outside your team",
    icon: InboxCheckIcon,
    value: "Off",
  },
  {
    label: "Cycles",
    description: "Focus your team over short, time-boxed windows",
    icon: Clock04Icon,
    value: "Off",
  },
]

const agentItems: Array<SettingItem> = [
  {
    label: "Team agents",
    description: "Add guidance for how agents should operate within this team",
    icon: Cursor02Icon,
  },
  {
    label: "Agent skills",
    description: "Agent skills shared with this team",
    icon: AiMagicIcon,
  },
  {
    label: "Project updates",
    description:
      "Automatically generate updates using recent activity and defined rules",
    icon: SquareActivity,
  },
  {
    label: "Resolved thread summaries",
    description: "Automatically generate summaries for resolved threads",
    icon: Summation01Icon,
  },
]

function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode
  description?: ReactNode
  title: string
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1 px-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function SettingRowContent({ item }: { item: SettingItem }) {
  return (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/50 bg-background/60 text-muted-foreground shadow-xs transition-colors group-hover:text-foreground">
        <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {item.label}
        </span>
        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
          {item.description}
        </span>
      </span>
      {item.value ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {item.value}
        </span>
      ) : null}
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        strokeWidth={2}
        className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </>
  )
}

function SettingsCard({
  items,
  teamSlug,
}: {
  items: Array<SettingItem>
  teamSlug?: string
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/35">
      {items.map((item, index) => {
        const className = cn(
          "group flex min-h-[68px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/55 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          index > 0 && "border-t border-border/60"
        )

        return item.section && teamSlug ? (
          <Link
            key={item.label}
            to="/settings/teams/$teamSlug/general"
            params={{ teamSlug }}
            className={className}
          >
            <SettingRowContent item={item} />
          </Link>
        ) : (
          <button
            key={item.label}
            type="button"
            onClick={() =>
              toast.info(`${item.label} settings are coming soon.`)
            }
            className={className}
          >
            <SettingRowContent item={item} />
          </button>
        )
      })}
    </div>
  )
}

function DangerRow({
  action,
  description,
  label,
  onAction,
}: {
  action: string
  description: string
  label: string
  onAction?: () => void
}) {
  return (
    <div className="flex min-h-[68px] items-center justify-between gap-5 px-4 py-2.5 not-first:border-t not-first:border-border/60">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
          {description}
        </p>
      </div>
      <button
        type="button"
        onClick={
          onAction ?? (() => toast.info(`${label} is not available yet.`))
        }
        className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {action}
      </button>
    </div>
  )
}

export function TeamSettingsOverview({ team }: { team: TeamSummary }) {
  const router = useRouter()
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [confirmationName, setConfirmationName] = React.useState("")
  const [isDeleting, setIsDeleting] = React.useState(false)
  const confirmationMatches = confirmationName.trim() === team.name

  function handleDeleteDialogOpenChange(open: boolean) {
    if (isDeleting) return

    setDeleteDialogOpen(open)
    if (!open) setConfirmationName("")
  }

  async function handleDeleteTeam() {
    if (!confirmationMatches || isDeleting) return

    setIsDeleting(true)

    try {
      const result = await deleteTeam({
        data: {
          slug: team.slug,
          confirmationName,
        },
      })

      if (!result.ok) {
        toast.error(result.message)
        return
      }

      setDeleteDialogOpen(false)
      setConfirmationName("")
      toast.success(`${result.team.name} was deleted.`, {
        description: "It can be restored for 30 days.",
      })
      await router.navigate({ to: "/workspace/teams" })
      await router.invalidate()
    } catch {
      toast.error("The team could not be deleted. Try again.")
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none px-6 pt-12 pb-4 [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[640px] pb-16">
          <div className="space-y-12">
            <section className="space-y-5">
              <div className="min-w-0 space-y-1 px-3">
                <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
                  <TeamSidebarIcon
                    icon={team.icon}
                    name={team.name}
                    className="size-5"
                  />
                  <span className="truncate">{team.name}</span>
                </h1>
                <p className="text-sm text-muted-foreground">
                  Accessible to all workspace members
                </p>
              </div>
              <SettingsCard items={overviewItems} teamSlug={team.slug} />
            </section>

            <SettingsSection title="Issues, projects, and docs">
              <SettingsCard items={issueItems} />
            </SettingsSection>

            <SettingsSection title="Workflow">
              <SettingsCard items={workflowItems} />
            </SettingsSection>

            <SettingsSection title="AI & Agents">
              <SettingsCard items={agentItems} />
            </SettingsSection>

            <SettingsSection
              title="Team hierarchy"
              description={
                <>
                  Teams can be nested to reflect your team structure and to
                  share workflows and settings.
                  <span className="mt-1 block text-foreground">Docs ↗</span>
                </>
              }
            >
              <div className="flex min-h-16 items-center justify-between gap-5 rounded-2xl border border-border/70 bg-muted/35 px-4 py-2.5">
                <span className="text-sm font-medium text-foreground">
                  Parent team
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled
                  className="rounded-lg font-normal disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted-foreground/25 disabled:hover:text-foreground disabled:hover:opacity-80"
                >
                  Available on Business
                </Button>
              </div>
            </SettingsSection>

            <SettingsSection title="Danger zone">
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-muted/35">
                <DangerRow
                  label="Leave team"
                  description="Remove yourself as a member of this team"
                  action="Leave team…"
                />
                <DangerRow
                  label="Retire team"
                  description="Prevent creating and updating issues in this team while preserving all historical data"
                  action="Retire…"
                />
                <DangerRow
                  label="Delete team"
                  description="Permanently delete this team and all its data, with a 30-day restoration window"
                  action="Delete…"
                  onAction={() => setDeleteDialogOpen(true)}
                />
              </div>
            </SettingsSection>
          </div>
        </div>
      </main>

      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={handleDeleteDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete {team.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The team will disappear immediately. Its data will be retained for
              a 30-day restoration window.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2">
            <label
              htmlFor="delete-team-confirmation"
              className="block text-sm font-medium text-foreground"
            >
              Type <span className="font-semibold">{team.name}</span> to confirm
            </label>
            <Input
              id="delete-team-confirmation"
              value={confirmationName}
              onChange={(event) => setConfirmationName(event.target.value)}
              autoComplete="off"
              autoFocus
              aria-label={`Type ${team.name} to confirm deletion`}
              className="rounded-lg border-border bg-background"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={!confirmationMatches || isDeleting}
              onClick={() => void handleDeleteTeam()}
            >
              {isDeleting ? "Deleting…" : "Delete team"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
