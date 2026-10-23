
import * as React from "react"
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Github01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

"use client"

type ImportSource = "Asana" | "Shortcut" | "GitHub" | "Jira" | "Linear"
type PrivateTeamSelection = "None" | "All private teams"

const importSources: ReadonlyArray<ImportSource> = [
  "Asana",
  "Shortcut",
  "GitHub",
  "Jira",
  "Linear",
]

function ServiceIcon({ service }: { service: ImportSource }) {
  if (service === "GitHub") {
    return <HugeiconsIcon icon={Github01Icon} strokeWidth={2} />
  }

  if (service === "Asana") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="5.2" r="3" fill="currentColor" />
        <circle cx="5.2" cy="13.4" r="3" fill="currentColor" />
        <circle cx="14.8" cy="13.4" r="3" fill="currentColor" />
      </svg>
    )
  }

  if (service === "Shortcut") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M6.2 4.2h4.6a3 3 0 0 1 0 6H9.2m4.6 5.6H9.2a3 3 0 0 1 0-6h1.6"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
        />
        <path
          d="m4.1 6.6 9.2 8.2"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2"
        />
      </svg>
    )
  }

  if (service === "Jira") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="m10 2.5 7.5 7.5-7.5 7.5L2.5 10 10 2.5Z"
          fill="currentColor"
        />
        <path
          d="m10 7 3 3-3 3-3-3 3-3Z"
          fill="var(--background)"
        />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="currentColor" />
      <path
        d="M4.8 7.3 12.7 15M5 11l4.1 4M8 4.8l7.2 7"
        fill="none"
        stroke="var(--background)"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
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

function SectionHeading({
  children,
  description,
}: {
  children: React.ReactNode
  description: React.ReactNode
}) {
  return (
    <div className="space-y-1 px-3">
      <h2 className="text-sm font-semibold text-foreground">{children}</h2>
      <p className="text-xs leading-4 text-muted-foreground">{description}</p>
    </div>
  )
}

export function ImportExportSettings() {
  const [privateTeams, setPrivateTeams] =
    React.useState<PrivateTeamSelection>("None")

  function openImportAssistant(source: ImportSource) {
    toast.info(`${source} import is not available yet.`, {
      description: "Import assistant support is coming to Forge.",
    })
  }

  function requestExport() {
    toast.success("Issue export requested.", {
      description:
        privateTeams === "None"
          ? "We’ll email you when the CSV is ready."
          : "Private team issues will be included in the emailed CSV.",
    })
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-none px-6 pt-4 pb-4 [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-[640px] pb-16">
        <div className="space-y-8">
          <h1 className="px-3 text-xl font-semibold tracking-tight text-foreground">
            Import &amp; export
          </h1>

          <section className="space-y-3">
            <SectionHeading
              description={
                <>
                  If you use another service to track issues, this tool will
                  create a copy of them in Forge.{" "}
                  <a
                    href="https://linear.app/docs/import-issues"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-foreground hover:underline"
                  >
                    Docs ↗
                  </a>
                </>
              }
            >
              Import assistant
            </SectionHeading>
            <SettingsCard>
              {importSources.map((source, index) => (
                <button
                  key={source}
                  type="button"
                  onClick={() => openImportAssistant(source)}
                  className={cn(
                    "group flex min-h-11 w-full items-center gap-3 px-4 py-1.5 text-left transition-colors hover:bg-muted/55 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    index > 0 && "border-t border-border/60"
                  )}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/50 bg-background/60 text-muted-foreground shadow-xs transition-colors group-hover:text-foreground [&>svg]:size-4">
                    <ServiceIcon service={source} />
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                    {source}
                  </span>
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                  />
                </button>
              ))}
            </SettingsCard>
          </section>

          <section className="space-y-3">
            <SectionHeading description="Import issues using our open-source command line tool. Supports Asana (CSV), Jira (CSV), GitHub (API), Pivotal Tracker (CSV), Shortcut (CSV), and Trello (JSON).">
              CLI import
            </SectionHeading>
            <SettingsCard>
              <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-1.5">
                <span className="text-sm font-medium text-foreground">
                  CLI Importer
                </span>
                <Button
                  nativeButton={false}
                  variant="ghost"
                  size="sm"
                  className="rounded-lg"
                  render={
                    <a
                      href="https://github.com/linear/linear/tree/master/packages/import"
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  Open
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                </Button>
              </div>
            </SettingsCard>
          </section>

          <section className="space-y-3">
            <SectionHeading description="You can export your issue data in CSV format. Once the export is available, we’ll email you the download link.">
              Export
            </SectionHeading>
            <SettingsCard>
              <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-1.5">
                <span className="text-sm font-medium text-foreground">
                  Issue data
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="rounded-lg"
                  onClick={requestExport}
                >
                  Export…
                </Button>
              </div>
              <div className="flex min-h-11 items-center justify-between gap-4 border-t border-border/60 px-4 py-1.5">
                <span className="text-sm font-medium text-foreground">
                  Include private teams
                </span>
                <DropdownMenu>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Include private teams"
                    render={<DropdownMenuTrigger />}
                    className="group rounded-lg font-normal"
                  >
                    <span>{privateTeams}</span>
                    <DropdownChevron className="size-3.5" />
                  </Button>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    className="min-w-[170px]"
                  >
                    <DropdownMenuRadioGroup
                      value={privateTeams}
                      onValueChange={(value) =>
                        setPrivateTeams(value as PrivateTeamSelection)
                      }
                    >
                      <DropdownMenuRadioItem value="None">
                        None
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="All private teams">
                        All private teams
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SettingsCard>
          </section>
        </div>
      </div>
    </main>
  )
}
