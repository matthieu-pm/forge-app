"use client"

import { Link } from "@tanstack/react-router"
import * as React from "react"
import { toast } from "sonner"
import type { TeamSummary } from "@/lib/team-contract"
import { Switch } from "@/components/ui/switch"

const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

export function TeamThreadSummariesSettings({
  team,
  available,
  canManage,
}: {
  team: TeamSummary
  available: boolean
  canManage: boolean
}) {
  const storageKey = `forge:team-thread-summaries:v1:${team.id}`
  const [enabled, setEnabled] = React.useState(true)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    function load() {
      try {
        const raw = localStorage.getItem(storageKey)
        if (raw !== null && raw !== "true" && raw !== "false")
          throw new Error("Invalid preference")
        setEnabled(raw !== "false")
        setError("")
      } catch {
        setError(
          "Saved settings could not be loaded. Your saved data has been preserved."
        )
      }
      setReady(true)
    }
    function onStorage(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) load()
    }
    load()
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [storageKey])
  function save(value: boolean) {
    if (!available || !canManage || !ready || error) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
      setEnabled(value)
    } catch {
      toast.error(
        "Thread summary settings could not be saved. Please try again."
      )
    }
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="forge-settings-scroll">
        <div className="forge-settings-content">
          <header className="forge-page-header forge-settings-header">
            <h1>Resolved thread summaries</h1>
            <p className="mt-1.5 text-sm leading-[22px] text-muted-foreground">
              Automatically generate summaries for resolved threads
            </p>
          </header>
          <section
            aria-label="Thread summary settings"
            className={`flex min-h-16 justify-between gap-4 rounded-xl bg-muted/35 px-4 py-4 ring-1 ring-border/30 sm:flex-row sm:items-center sm:gap-6 ${available ? "flex-row items-center" : "flex-col items-start"}`}
          >
            <div className={`min-w-0 ${available ? "" : "opacity-50"}`}>
              <label
                htmlFor={available ? "enable-thread-summaries" : undefined}
                className="text-sm"
              >
                Enable thread summaries
              </label>
              <p
                id="thread-summaries-description"
                className="mt-0.5 text-xs leading-4 text-muted-foreground"
              >
                Generate summaries for resolved threads that don't have a
                resolving reply comment
              </p>
            </div>
            {available ? (
              <span
                className="shrink-0"
                title={
                  !canManage
                    ? "Only workspace owners, admins, and team members can modify this setting"
                    : undefined
                }
              >
                <Switch
                  id="enable-thread-summaries"
                  aria-describedby="thread-summaries-description"
                  checked={enabled}
                  disabled={!ready || !canManage || !!error}
                  onCheckedChange={save}
                  className="mr-1 data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] data-unchecked:bg-muted-foreground/60 [&_[data-slot=switch-thumb]]:bg-white [&_[data-slot=switch-thumb]]:motion-reduce:transition-none"
                />
              </span>
            ) : (
              <Link
                to="/settings/billing"
                className={`shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground ${focusClass}`}
              >
                Available on Business
              </Link>
            )}
          </section>
          {error && available && (
            <p role="alert" className="mt-3 px-4 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
