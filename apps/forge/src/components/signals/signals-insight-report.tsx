import type { ReactNode } from "react"
import type { SignalInsight } from "@/lib/signals-insights"
import { resolveSignalScope } from "@/lib/signals-accounts"

export function SignalsInsightReport({
  insight,
  issueComposer,
}: {
  insight: SignalInsight
  issueComposer: ReactNode
}) {
  const { account, project } = resolveSignalScope(
    insight.accountId,
    insight.projectId
  )
  return (
    <article className="mx-auto w-full max-w-[780px] px-6 py-8 sm:px-10 lg:px-12">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {account.name} / {project.name}
        </span>
        <span aria-hidden="true">·</span>
        <span>{insight.category}</span>
      </div>
      <h2 className="text-xl leading-7 font-medium tracking-tight">
        {insight.title}
      </h2>
      <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
        {insight.summary}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <span
          title={insight.confidenceReason}
          className="rounded-full bg-muted/65 px-2.5 py-1 text-muted-foreground"
        >
          {insight.confidence}% confidence ·{" "}
          {insight.confidence >= 85 ? "High" : "Moderate"}
        </span>
        <span className="text-muted-foreground">
          {account.provider} · Detected {insight.detected}
        </span>
      </div>
      <dl className="my-7 grid grid-cols-3 gap-4 border-y border-border/40 py-5">
        {insight.metrics.map((metric) => (
          <div key={metric.label}>
            <dt className="text-[11px] leading-4 text-muted-foreground">
              {metric.label}
            </dt>
            <dd className="mt-2 text-xl font-medium tabular-nums">
              {metric.value}
              <span className="mt-1 block text-[10px] leading-4 font-normal text-muted-foreground">
                {metric.context}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <section aria-label="Insight evidence">
        <h3 className="text-[13px] font-medium">What we found</h3>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {insight.finding}
        </p>
        <ul className="mt-3 space-y-2 pl-4 text-[13px] leading-6 text-muted-foreground marker:text-muted-foreground/60">
          {insight.evidence.map((evidence) => (
            <li className="list-disc" key={evidence}>
              {evidence}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground/80">
          {insight.confidenceReason}
        </p>
      </section>
      <section className="mt-6">
        <h3 className="text-[13px] font-medium">Suggested next step</h3>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          {insight.recommendation}
        </p>
      </section>
      <section aria-label="Draft issue" className="mt-8">
        <h3 className="mb-3 text-xs text-muted-foreground">Draft issue</h3>
        {issueComposer}
      </section>
      <p className="mt-4 text-[10px] leading-5 text-muted-foreground/70">
        Fictional sample insight. Confidence is an illustrative
        evidence-strength score, not a measured probability. Review the draft
        before creating an issue.
      </p>
    </article>
  )
}
