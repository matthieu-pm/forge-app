import { resolveSignalScope } from "./signals-accounts"
import type { DocumentChart } from "./document-chart"
import type { SignalInsight } from "./signals-insights"

type EvidenceChart = Omit<DocumentChart, "source"> & { period: string }

// Authored simulation, not provider API responses. Totals agree with each report.
const charts: Record<string, EvidenceChart> = {
  "SIG-108": {
    title: "Teammate invite funnel",
    kind: "funnel",
    unit: "count",
    series: ["Invite attempts"],
    points: [
      { label: "Reached role selection", values: [312] },
      { label: "Sent invitation", values: [131] },
    ],
    period: "Oct 20–26, 2026",
    caption:
      "131 of 312 attempts completed (42%). 181 left at role selection. Previous-period completion: 68%.",
  },
  "SIG-107": {
    title: "Search sessions with no result opened",
    kind: "bar",
    unit: "percent",
    series: ["No result opened"],
    points: [
      { label: "Active boards", values: [12] },
      { label: "Archived boards", values: [38] },
    ],
    period: "Oct 20–26, 2026",
    caption:
      "Archived: 109 of 286 search sessions (38%, rounded). Active-board baseline: 12%. These are sessions, not unique users.",
  },
  "SIG-106": {
    title: "Recovery after a date-format error",
    kind: "line",
    unit: "count",
    series: ["Accounts recovered"],
    points: [
      { label: "0h", values: [0] },
      { label: "1h", values: [3] },
      { label: "4h", values: [8] },
      { label: "8h", values: [11] },
      { label: "12h", values: [15] },
      { label: "24h", values: [19] },
    ],
    period: "Errors detected Oct 19–25, 2026 · 24h follow-up",
    caption:
      "Cumulative recovery among 58 affected accounts. 19 recovered within 24 hours (33%, rounded); 39 had not recovered by then.",
  },
  "SIG-105": {
    title: "Reports discovery by signup cohort",
    kind: "bar",
    unit: "count",
    series: ["Opened Reports", "Did not open"],
    points: [
      { label: "Sep 28", values: [35, 215] },
      { label: "Oct 5", values: [30, 220] },
      { label: "Oct 12", values: [40, 210] },
      { label: "Oct 19", values: [35, 215] },
    ],
    period: "Four complete weeks · Sep 28–Oct 25, 2026",
    caption:
      "140 of 1,000 eligible owners discovered Reports (14%). Each cohort contains 250 owners. Repeat use is measured separately from discovery.",
  },
  "SIG-104": {
    title: "Approval completion by device",
    kind: "bar",
    unit: "percent",
    series: ["Completed", "Not completed"],
    points: [
      { label: "Mobile", values: [47, 53] },
      { label: "Desktop", values: [76, 24] },
    ],
    period: "Oct 19–25, 2026",
    caption:
      "Completion as a share of review sessions on each device. Device and account differences may contribute to the gap.",
  },
  "SIG-103": {
    title: "Next-week return by saved-view cohort",
    kind: "horizontalBar",
    unit: "percent",
    series: ["Returned next week"],
    points: [
      { label: "Saved a view · 184 partners", values: [54] },
      { label: "No saved view · 392 partners", values: [31] },
    ],
    period: "First week Oct 5–11 · Return Oct 12–18, 2026",
    caption:
      "99 of 184 partners who saved a view returned (54%); 122 of 392 others returned (31%). Rounded percentages. This association does not establish causation.",
  },
}

export function signalInsightChart(insight: SignalInsight): DocumentChart {
  const { period, ...chart } = charts[insight.id]
  const { account, project } = resolveSignalScope(
    insight.accountId,
    insight.projectId
  )
  return {
    ...chart,
    source: {
      provider: account.provider,
      account: account.name,
      product: project.name,
      period,
      simulated: true,
    },
  }
}
