"use client"

import * as React from "react"
import {
  Download04Icon,
  File02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import type { AgentEvent } from "@/application/agents/event-contract"
import { Button } from "@/components/ui/button"

export function AgentArtifactCard({ event }: { event: AgentEvent }) {
  const [downloading, setDownloading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const name =
    typeof event.payload.name === "string"
      ? event.payload.name
      : "Generated artifact"
  const contentType =
    typeof event.payload.contentType === "string"
      ? event.payload.contentType
      : "File"

  return (
    <article className="flex items-center gap-3 rounded-xl border bg-card p-3">
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0"
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
      ) : null}
      {error ? (
        <p role="alert" className="sr-only">
          {error}
        </p>
      ) : null}
    </article>
  )
}
