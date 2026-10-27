import { Suspense, lazy, useState } from "react"
import { Link } from "@tanstack/react-router"
import type { TeamSummary } from "@/lib/team-contract"
import type { InboxScope } from "@/lib/inbox-state"
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
        <div className="w-[350px] max-w-full">
          <SignalsEmptyArt />
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

function SignalsEmptyArt() {
  return (
    <svg
      aria-hidden="true"
      width="110"
      height="80"
      viewBox="0 0 110 80"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted-foreground/80"
    >
      <path d="M59 50a24 24 0 1 1-48 0 24 24 0 0 1 48 0Z" />
      <path d="M11 50v3a24 24 0 0 0 48 0v-3" />
      <path d="m27 45 37-37m6-6-3 3m-28 51 12-12m14-7 22-22m6-6 4-4" />
      <path d="m78 43 18-18" />
      <circle cx="22" cy="58" r="2.5" />
      <circle cx="43" cy="64" r="1.5" />
    </svg>
  )
}
