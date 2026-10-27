"use client"

import * as React from "react"
import { useBlocker } from "@tanstack/react-router"
import { z } from "zod"
import type { TeamSummary } from "@/lib/team-contract"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const guidanceSchema = z.object({ guidance: z.string().max(50000) })
const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

export function TeamProjectUpdatesSettings({ team }: { team: TeamSummary }) {
  const storageKey = `forge:team-project-updates:v1:${team.id}`
  const [guidance, setGuidance] = React.useState("")
  const [ready, setReady] = React.useState(false)
  const [loadError, setLoadError] = React.useState("")
  const [saveError, setSaveError] = React.useState("")
  const unsaved = React.useRef(false)
  const blocker = useBlocker({
    shouldBlockFn: () => unsaved.current,
    enableBeforeUnload: () => unsaved.current,
    withResolver: true,
  })
  React.useEffect(() => {
    function load() {
      if (unsaved.current) return
      try {
        const raw = localStorage.getItem(storageKey)
        setGuidance(raw ? guidanceSchema.parse(JSON.parse(raw)).guidance : "")
        setLoadError("")
      } catch {
        setLoadError(
          "Saved guidance could not be loaded. Your data has been preserved. Reload to try again."
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

  function save(value: string) {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(guidanceSchema.parse({ guidance: value }))
      )
      unsaved.current = false
      setSaveError("")
    } catch {
      unsaved.current = true
      setSaveError(
        "Your guidance could not be saved. Your text is still here; try saving again."
      )
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="forge-settings-scroll">
        <div className="forge-settings-content">
          <header className="forge-page-header forge-settings-header">
            <h1>Project updates</h1>
            <p
              id="project-updates-description"
              className="mt-1.5 text-sm leading-[22px] text-muted-foreground"
            >
              Customize how project updates should be written
            </p>
          </header>
          {loadError && (
            <p role="alert" className="mb-4 px-4 text-sm text-destructive">
              {loadError}
            </p>
          )}
          <textarea
            aria-label="AI prompt rules"
            aria-describedby="project-updates-description"
            placeholder="Optional guidance..."
            maxLength={50000}
            value={guidance}
            disabled={!ready || !!loadError}
            onChange={(event) => {
              const value = event.target.value
              setGuidance(value)
              save(value)
            }}
            className={`block h-[180px] w-full resize-none rounded-xl bg-muted/35 p-4 text-sm leading-[22px] ring-1 ring-border/30 placeholder:text-muted-foreground/60 disabled:opacity-50 ${focusClass}`}
          />
          <span role="status" className="sr-only">
            {saveError
              ? "Guidance not saved"
              : ready && !loadError
                ? "Guidance saved"
                : ""}
          </span>
          {saveError && (
            <div className="mt-3 flex flex-wrap items-center gap-3 px-4">
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
              <Button variant="secondary" onClick={() => save(guidance)}>
                Try again
              </Button>
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.()
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>
              Your latest guidance could not be saved. Stay on this page to try
              again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
