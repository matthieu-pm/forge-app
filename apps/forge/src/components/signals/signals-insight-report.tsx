import { useState } from "react"
import type { ReactNode } from "react"
import type { SignalInsight } from "@/lib/signals-insights"
import type { TeamResource } from "@/lib/team-home-state"
import { resolveSignalScope } from "@/lib/signals-accounts"
import { DocumentContent } from "@/components/documents/document-content"
import {
  defaultDocumentIcon,
  documentPlainText,
  teamDocumentBody,
} from "@/lib/team-documents"

export function SignalsInsightReport({
  insight,
  document,
  onDocumentChange,
  issueComposer,
}: {
  insight: SignalInsight
  document: TeamResource
  onDocumentChange: (document: TeamResource) => void
  issueComposer: ReactNode
}) {
  const [title, setTitle] = useState(document.title)
  const { account, project } = resolveSignalScope(
    insight.accountId,
    insight.projectId
  )
  return (
    <DocumentContent
      title={title}
      body={teamDocumentBody(document)}
      icon={document.icon ?? defaultDocumentIcon}
      onTitleChange={(value) => {
        setTitle(value)
        onDocumentChange({ ...document, title: value.trim() || "New document" })
      }}
      onBodyChange={(body) =>
        onDocumentChange({
          ...document,
          body: body as TeamResource["body"],
          content: documentPlainText(body),
        })
      }
      onIconChange={(icon) => onDocumentChange({ ...document, icon })}
      metadata={
        <div className="mb-7 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 pb-5 text-[11px] text-muted-foreground">
          <span className="rounded-md bg-muted px-2 py-0.5">
            Draft document
          </span>
          <span>
            {account.provider} · {account.name} / {project.name}
          </span>
          <span title={insight.confidenceReason}>
            {insight.confidence}% confidence
          </span>
          <span>Simulated data</span>
        </div>
      }
    >
      <section
        aria-label="Draft issue"
        className="mt-10 border-t border-border/40 pt-6"
      >
        <h3 className="mb-3 text-xs text-muted-foreground">Draft issue</h3>
        {issueComposer}
      </section>
      <p className="mt-4 text-[10px] leading-5 text-muted-foreground/70">
        Fictional insight with simulated {account.provider} data. Confidence is
        an illustrative evidence-strength score, not a measured probability.
        Document edits save on this device.
      </p>
    </DocumentContent>
  )
}
