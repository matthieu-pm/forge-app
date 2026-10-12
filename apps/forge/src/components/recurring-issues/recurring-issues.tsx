import * as React from "react"
import { Link, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import type { SavedRecurringIssue } from "@/lib/recurring-issue-contract"
import { formatDueDate, recurrenceLabel } from "@/lib/recurring-issue-contract"
import { deleteRecurringIssue } from "@/lib/recurring-issue-state"
import { Glyph, TemplateShell } from "@/components/templates/template-controls"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const docsUrl =
  "https://linear.app/docs/creating-issues#create-recurring-issues"
export function RecurringIssues({
  team,
  issues,
  canManage,
}: {
  team: TeamSummary
  issues: Array<SavedRecurringIssue>
  canManage: boolean
}) {
  const router = useRouter()
  const [deleting, setDeleting] = React.useState<SavedRecurringIssue | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  async function remove() {
    if (!deleting || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await deleteRecurringIssue({
        data: {
          slug: team.slug,
          id: deleting.id,
          updatedAt: deleting.updatedAt,
        },
      })
      await router.invalidate()
      setDeleting(null)
      toast.success("Recurring issue deleted.")
    } catch (failure) {
      toast.error(
        failure instanceof Error
          ? failure.message
          : "Could not delete the recurring issue."
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <TemplateShell team={team} overview section="recurring-issues">
      <div className="mx-auto max-w-[680px] px-5 pt-4 pb-10">
        <h1 className="px-4 text-2xl font-medium tracking-tight">
          Recurring issues
        </h1>
        <p className="mt-2 px-4 text-[13px] leading-[22px] text-muted-foreground">
          Automatically create issues that need to be completed on a regular
          schedule. Each issue is created with a due date set by the schedule. A
          new instance is created after each due date passes.{" "}
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap text-foreground hover:underline"
          >
            Docs ↗
          </a>
        </p>
        <section
          aria-label="Recurring issues"
          className="mt-8 overflow-hidden rounded-xl border border-border/40 bg-muted/35"
        >
          <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13px]">
            <span className="text-muted-foreground">
              {issues.length
                ? `${issues.length} recurring issue${issues.length === 1 ? "" : "s"}`
                : "No recurring issues"}
            </span>
            {canManage && (
              <Link
                to="/settings/teams/$teamSlug/recurring-issues/$recurringId"
                params={{ teamSlug: team.slug, recurringId: "new" }}
                className="inline-flex h-7 items-center gap-2 rounded-full px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Glyph name="add" />
                New recurring issue
              </Link>
            )}
          </div>
          {issues.map((issue) => (
            <div
              key={issue.id}
              className="group flex items-center border-t border-border/50 hover:bg-muted/40"
            >
              <Link
                to="/settings/teams/$teamSlug/recurring-issues/$recurringId"
                params={{ teamSlug: team.slug, recurringId: issue.id }}
                className="flex min-w-0 flex-1 items-center gap-3 p-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted/80">
                  <TeamSidebarIcon
                    icon={issue.payload.icon}
                    name={issue.payload.title}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">
                    {issue.payload.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {recurrenceLabel(issue.payload)} · First due{" "}
                    {formatDueDate(issue.payload.firstDue)}
                  </span>
                </span>
              </Link>
              {canManage && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Options for ${issue.payload.title}`}
                    render={
                      <button
                        type="button"
                        className="mr-3 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      />
                    }
                  >
                    <Glyph name="more" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="rounded-xl">
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleting(issue)}
                    >
                      Delete recurring issue…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          ))}
        </section>
      </div>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null)
        }}
      >
        <DialogContent className="rounded-xl sm:max-w-sm">
          <DialogTitle>Delete recurring issue?</DialogTitle>
          <DialogDescription>
            Delete “{deleting?.payload.title}” and its saved schedule? This
            cannot be undone.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "Deleting…" : "Delete recurring issue"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </TemplateShell>
  )
}
