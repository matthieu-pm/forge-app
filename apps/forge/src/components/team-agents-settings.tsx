"use client"

import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"

const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const textLinkClass = `rounded-sm text-foreground underline-offset-4 hover:underline ${focusClass}`

export function TeamAgentsSettings(_props: { team: TeamSummary }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="forge-settings-scroll">
        <div className="forge-settings-content">
          <header className="forge-page-header forge-settings-header">
            <h1>Team agents</h1>
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
