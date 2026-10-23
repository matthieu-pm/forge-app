"use client"

import { Link } from "@tanstack/react-router"
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"

const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const textLinkClass = `rounded-sm text-foreground underline-offset-4 hover:underline ${focusClass}`

export function TeamAgentsSettings({ team }: { team: TeamSummary }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="forge-page-back flex h-12 shrink-0 items-center px-4">
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
          <header className="forge-page-header px-4 pb-8">
            <h1 className="text-2xl font-medium tracking-tight">Team agents</h1>
            <p className="mt-1.5 text-sm leading-[22px] text-muted-foreground">
              AI agents can work alongside you as teammates. Tackle complex
              tasks together or delegate entire issues end-to-end.{" "}
              <a
                href="https://linear.app/docs/agents-in-linear"
                target="_blank"
                rel="noreferrer"
                aria-label="Agents documentation (opens in a new tab)"
                className={`whitespace-nowrap ${textLinkClass}`}
              >
                Docs ↗
              </a>
            </p>
          </header>
          <section
            aria-label="Team agent settings"
            className="flex min-h-16 items-center rounded-xl bg-muted/35 px-4 py-4 ring-1 ring-border/30"
          >
            <p className="text-sm leading-[22px] text-muted-foreground">
              Browse{" "}
              <button
                type="button"
                className={textLinkClass}
                onClick={() =>
                  toast.info("Agent integrations are coming soon.")
                }
              >
                integrations
              </button>{" "}
              to enable new agents
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
