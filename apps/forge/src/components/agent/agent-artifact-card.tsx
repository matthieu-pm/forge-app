"use client"

import * as React from "react"
import {
  Download04Icon,
  File02Icon,
  Loading03Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import type { AgentEvent } from "@/application/agents/event-contract"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export function AgentArtifactCard({ event }: { event: AgentEvent }) {
  const [downloading, setDownloading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null)
  const [previewing, setPreviewing] = React.useState(false)
  const name =
    typeof event.payload.name === "string"
      ? event.payload.name
      : "Generated artifact"
  const contentType =
    typeof event.payload.contentType === "string"
      ? event.payload.contentType
      : "File"

  return (
    <article className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3">
      <div className="flex size-8 items-center justify-center rounded-lg bg-muted">
        <HugeiconsIcon icon={File02Icon} strokeWidth={2} className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {contentType}
        </p>
      </div>
      {typeof event.payload.id === "string" ? (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Preview ${name}`}
            disabled={previewing}
            onClick={async () => {
              setPreviewing(true)
              setError(null)
              try {
                const response = await fetch(
                  `/api/files/artifacts/${encodeURIComponent(event.payload.id as string)}/grant`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ purpose: "preview" }),
                  }
                )
                if (!response.ok) throw new Error("Preview unavailable")
                const result = (await response.json()) as { url: string }
                // Check the preview response before displaying it; use its original URL to retain CSP.
                const preview = await fetch(result.url)
                await preview.body?.cancel()
                if (!preview.ok) throw new Error("Preview unavailable")
                setPreviewUrl(result.url)
              } catch {
                setError(
                  "A preview is unavailable for this file. Download it to view it."
                )
              } finally {
                setPreviewing(false)
              }
            }}
          >
            <HugeiconsIcon
              icon={previewing ? Loading03Icon : ViewIcon}
              strokeWidth={2}
              className={previewing ? "animate-spin" : undefined}
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={`Download ${name}`}
            disabled={downloading}
            onClick={async () => {
              setDownloading(true)
              setError(null)
              try {
                const response = await fetch(
                  `/api/agent/artifacts/${encodeURIComponent(event.payload.id as string)}`
                )
                if (!response.ok) throw new Error("Artifact unavailable")
                const result = (await response.json()) as {
                  downloadUrl: string
                }
                const anchor = document.createElement("a")
                anchor.href = result.downloadUrl
                anchor.download = name
                anchor.click()
              } catch {
                setError(
                  "This artifact could not be downloaded. The link may have expired."
                )
              } finally {
                setDownloading(false)
              }
            }}
          >
            <HugeiconsIcon
              icon={downloading ? Loading03Icon : Download04Icon}
              strokeWidth={2}
              className={downloading ? "animate-spin" : undefined}
            />
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog
        open={previewUrl !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewUrl(null)
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogTitle className="truncate pr-8">{name}</DialogTitle>
          <DialogDescription>File preview</DialogDescription>
          {previewUrl ? (
            <iframe
              title={`Preview of ${name}`}
              src={previewUrl}
              sandbox=""
              referrerPolicy="no-referrer"
              className="h-[60vh] w-full rounded-lg border bg-white"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </article>
  )
}
