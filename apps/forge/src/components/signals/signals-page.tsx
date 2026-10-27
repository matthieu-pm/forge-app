import { Suspense, lazy, useState } from "react"
import { Link } from "@tanstack/react-router"
import type { TeamSummary } from "@/lib/team-contract"
import type { InboxScope } from "@/lib/inbox-state"
import { EmptyStateArt } from "@/components/illustrations/empty-state-art"
import { Button } from "@/components/ui/button"
import { ContentHeader } from "@/components/ui/content-header"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const SignalsInbox = lazy(() =>
  import("./signals-inbox").then((module) => ({
    default: module.SignalsInbox,
  }))
)

export function SignalsPage({
  preview = false,
  onPreviewChange,
  team,
  scope,
}: {
  preview?: boolean
  onPreviewChange: (preview: boolean) => void
  team?: TeamSummary
  scope: InboxScope
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  const header = (
    <ContentHeader className="justify-between">
      <h1 className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
        {team && (
          <>
            <TeamSidebarIcon name={team.name} icon={team.icon} />
            <span className="truncate text-muted-foreground">{team.name}</span>
            <span className="text-muted-foreground/50">›</span>
          </>
        )}
        Signals
      </h1>
      <Button
        variant="outline"
        size="sm"
        className="px-2 text-xs font-normal text-muted-foreground"
        onClick={() => onPreviewChange(!preview)}
      >
        {preview ? "Exit preview" : "Preview with sample data"}
      </Button>
    </ContentHeader>
  )

  if (preview) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <Suspense
          fallback={
            <p role="status" className="m-auto text-xs text-muted-foreground">
              Loading sample insights…
            </p>
          }
        >
          <SignalsInbox scope={scope} team={team} />
        </Suspense>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto px-8 py-10 pb-12">
        <div className="empty-state-content w-[350px] max-w-full">
          <EmptyStateArt kind="signals" />
          <h2 className="mt-6 text-sm font-medium">Signals</h2>
          <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
            See what your users need. Review insights from product usage and
            turn the ones that matter into issues.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              render={<Link to="/settings/signals" />}
              size="sm"
              className="rounded-full text-xs font-normal"
            >
              Configure Signals
            </Button>
            <Button
              variant="secondary"
              size="xs"
              className="h-7 rounded-full text-xs"
              onClick={() => setHelpOpen(true)}
            >
              Documentation
            </Button>
          </div>
        </div>
        <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Understand your users with Signals</DialogTitle>
              <DialogDescription>
                Signals turns product usage into an inbox of insights, with
                supporting evidence and a draft issue for each finding.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-[13px] leading-relaxed text-muted-foreground">
              <p>
                Start in Signals settings to choose the events you want to track
                and the questions you want to explore.
              </p>
              <p>
                Product connections are not available yet. You can save your
                preferences now; usage data will appear here once your product
                is connected and sending events.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  )
}
