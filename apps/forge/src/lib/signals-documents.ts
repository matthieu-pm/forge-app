import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { teamResourceSchema } from "./team-home-state"
import { documentPlainText, newTeamDocument } from "./team-documents"
import { signalInsightChart } from "./signals-insight-charts"
import type { JSONContent } from "@tiptap/core"
import type { SignalInsight } from "./signals-insights"
import type { TeamResource } from "./team-home-state"
import type { InboxScope } from "./inbox-state"

const draftsSchema = z.record(z.string(), teamResourceSchema)
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
})
const heading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
})

export function newSignalDocument(insight: SignalInsight): TeamResource {
  const chart = signalInsightChart(insight)
  const body: JSONContent = {
    type: "doc",
    content: [
      paragraph(insight.summary),
      heading("What we found"),
      paragraph(insight.finding),
      { type: "analyticsChart", attrs: { chart } },
      {
        type: "bulletList",
        content: insight.evidence.map((text) => ({
          type: "listItem",
          content: [paragraph(text)],
        })),
      },
      paragraph(insight.confidenceReason),
      heading("Suggested next step"),
      paragraph(insight.recommendation),
    ],
  }
  return {
    ...newTeamDocument(),
    id: `signal-document:${insight.id}`,
    title: insight.title,
    body: body as TeamResource["body"],
    content: documentPlainText(body),
    icon: { kind: "icon", value: "Asteroid02Icon", color: "#94949e" },
  }
}

export const signalDocumentsKey = (scope: InboxScope) =>
  `forge:signal-documents:v1:${JSON.stringify([scope.workspaceId, scope.userId])}`

export function useSignalDocuments(scope: InboxScope) {
  const key = signalDocumentsKey(scope)
  const [documents, setDocuments] = useState<Record<string, TeamResource>>({})
  const latest = useRef(documents)
  const [error, setError] = useState("")
  const [ready, setReady] = useState(false)
  const [readError, setReadError] = useState(false)
  useEffect(() => {
    setReady(false)
    try {
      const raw = localStorage.getItem(key)
      const saved = raw ? draftsSchema.parse(JSON.parse(raw)) : {}
      latest.current = saved
      setDocuments(saved)
      setReadError(false)
      setError("")
      setReady(true)
    } catch {
      setReadError(true)
      setError(
        "Saved insight drafts could not be read. Reload to try again; your saved data has been preserved."
      )
    }
  }, [key])
  useEffect(() => {
    if (!error || readError) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [error, readError])
  function persist(next: Record<string, TeamResource>) {
    try {
      localStorage.setItem(key, JSON.stringify(draftsSchema.parse(next)))
      setError("")
      return true
    } catch {
      setError(
        "Your insight edits could not be saved on this device. Keep this page open and try again."
      )
      return false
    }
  }
  function save(document: TeamResource) {
    if (!ready || readError) return false
    const next = {
      ...latest.current,
      [document.id]: { ...document, updatedAt: new Date().toISOString() },
    }
    latest.current = next
    setDocuments(next)
    return persist(next)
  }
  return {
    documents,
    ready,
    error,
    readError,
    save,
    retry: () => persist(latest.current),
  }
}
