export type SignalInsight = {
  id: string
  accountId: string
  projectId: string
  title: string
  description: string
  confidence: number
  confidenceReason: string
  detected: string
  category: "Friction" | "Adoption" | "Retention" | "Opportunity"
  summary: string
  finding: string
  evidence: Array<string>
  metrics: Array<{ label: string; value: string; context: string }>
  recommendation: string
  draft: {
    title: string
    priority: "High" | "Medium" | "Low"
    description: string
  }
}
export type SignalInsightStatus = "inbox" | "reviewed" | "dismissed"

// Authored fictional reports for the preview, not computed analytics or model probabilities.
export const sampleSignalInsights: Array<SignalInsight> = [
  {
    id: "SIG-108",
    accountId: "acme-posthog",
    projectId: "acme-product",
    title: "Invites stall on permissions",
    description: "New workspaces lose teammates at the role-selection step.",
    confidence: 94,
    confidenceReason:
      "The same drop-off appears across three signup cohorts and both major desktop browsers. Session evidence supports the location of the problem, but does not establish its cause.",
    detected: "Oct 26",
    category: "Friction",
    summary:
      "New workspace owners start inviting teammates, but many stop when asked to choose a role. This is the largest observed drop-off in the first-session journey.",
    finding:
      "Invite completion fell from 68% to 42% over the last seven days. The change is concentrated at role selection, while the preceding email-entry step stayed stable.",
    evidence: [
      "312 first-time invite attempts reached role selection. Of these, 131 completed the flow and 181 left before sending an invite.",
      "In the sample session review, people repeatedly opened the role descriptions before leaving. This suggests unclear permissions may contribute to the drop-off.",
    ],
    metrics: [
      { label: "Invite completion", value: "42%", context: "Previously 68%" },
      {
        label: "Affected attempts",
        value: "181",
        context: "At role selection",
      },
      { label: "Review window", value: "7 days", context: "Oct 20–26" },
    ],
    recommendation:
      "Explain each role where it is selected and test a clear default. Validate the change against completed invites, rather than clicks on the invite button.",
    draft: {
      title: "Clarify permissions in the teammate invite flow",
      priority: "High",
      description:
        "Problem\nFirst-time workspace owners hesitate at role selection. In the sample data, only 131 of 312 invite attempts completed (42%), down from 68% in the previous period.\n\nProposed change\nAdd plain-language descriptions of each role and make the recommended role clear. Keep permission details accessible before the invite is sent.\n\nAcceptance criteria\n• Each role explains what a teammate can view and change.\n• The selected role is visible before sending the invitation.\n• Track role selection, invite submission, and successful delivery separately.\n\nSuccess measure\nCompare invite completion for new workspaces with the previous flow.\n\nSource: SIG-108 · Fictional Signals preview evidence.",
    },
  },
  {
    id: "SIG-107",
    accountId: "acme-posthog",
    projectId: "acme-product",
    title: "Search ends without a result",
    description:
      "People searching for archived boards often leave empty-handed.",
    confidence: 91,
    detected: "Oct 26",
    category: "Friction",
    confidenceReason:
      "The event pattern is repeated across 74 distinct users. Query intent is inferred from sample sessions and needs validation.",
    summary:
      "Search works for active boards, but archived content is difficult to find. Users frequently leave search without opening a result after trying to locate older work.",
    finding:
      "Of 286 search sessions involving archived content, 109 ended without a result being opened. The equivalent rate for active-board searches is 12%.",
    evidence: [
      "74 users repeated or reformulated an archived-board search within the same session.",
      "Archived results require a separate filter that was enabled in only 18% of the affected sessions.",
    ],
    metrics: [
      { label: "No result opened", value: "38%", context: "Archived searches" },
      { label: "Active-board baseline", value: "12%", context: "Same period" },
      { label: "Affected users", value: "74", context: "Distinct users" },
    ],
    recommendation:
      "Make archived results discoverable from the initial result list, then check whether people successfully open the content they need.",
    draft: {
      title: "Make archived boards discoverable in search",
      priority: "Medium",
      description:
        "Problem\nIn the sample data, 38% of archived-board search sessions end without a result being opened, compared with 12% for active boards.\n\nProposed change\nOffer a visible way to include archived content when a search returns few or no active matches.\n\nAcceptance criteria\n• People can include archived content from the results screen.\n• Archived boards are clearly labeled.\n• Track successful result opens separately from searches.\n\nSource: SIG-107 · Fictional Signals preview evidence.",
    },
  },
  {
    id: "SIG-106",
    accountId: "northstar-amplitude",
    projectId: "northstar-product",
    title: "Setup errors block imports",
    description:
      "CSV imports fail on dates without explaining how to fix them.",
    confidence: 96,
    detected: "Oct 26",
    category: "Friction",
    confidenceReason:
      "Failures share the same validation code and are reproduced in the sample walkthrough. The affected cohort contains 58 distinct accounts.",
    summary:
      "Users can upload a CSV successfully but lose progress when date validation fails. The failure message identifies the file, without identifying the affected rows.",
    finding:
      "58 accounts encountered a date-format validation error during import. Only 19 completed an import within the next 24 hours.",
    evidence: [
      "All 58 failures used the same date-validation error code.",
      "The sample walkthrough shows users retrying the unchanged file after the generic error message.",
    ],
    metrics: [
      {
        label: "Affected accounts",
        value: "58",
        context: "Date-format failures",
      },
      { label: "Recovered in 24h", value: "33%", context: "19 of 58 accounts" },
      {
        label: "Repeat attempts",
        value: "2.8",
        context: "Average per failure",
      },
    ],
    recommendation:
      "Identify invalid rows and accepted date formats before starting the import. Preserve the uploaded file while users correct the mapping.",
    draft: {
      title: "Show actionable row-level errors for CSV imports",
      priority: "High",
      description:
        "Problem\nDate-format validation failures prevent users from completing their first CSV import. The sample data shows 58 affected accounts, with 19 recovering within 24 hours.\n\nProposed change\nValidate mapped dates before import and show affected rows with supported formats.\n\nAcceptance criteria\n• Invalid rows and columns are identified.\n• The accepted date format is shown beside the error.\n• Fixing a mapping does not require another upload.\n• Successful retries are measurable.\n\nSource: SIG-106 · Fictional Signals preview evidence.",
    },
  },
  {
    id: "SIG-105",
    accountId: "studio-posthog",
    projectId: "studio-product",
    title: "Reports are hard to discover",
    description:
      "People who need weekly summaries rarely find the Reports page.",
    confidence: 86,
    detected: "Oct 25",
    category: "Adoption",
    confidenceReason:
      "Low discovery repeats across four weekly cohorts. Interview context is absent, so the assumed need for reporting remains a hypothesis.",
    summary:
      "Reports have low discovery among workspace owners. Once someone opens a report, they are much more likely to open it again the following week.",
    finding:
      "Only 14% of eligible workspace owners opened Reports this month. Of those who did, 61% returned to Reports in the next complete week.",
    evidence: [
      "Discovery is low in all four complete weekly signup cohorts.",
      "Repeated report use is associated with workspace ownership; this does not prove that increasing discovery would improve retention.",
    ],
    metrics: [
      { label: "Feature discovery", value: "14%", context: "Eligible owners" },
      {
        label: "Weekly repeat use",
        value: "61%",
        context: "Of report discoverers",
      },
      { label: "Cohorts reviewed", value: "4", context: "Complete weeks" },
    ],
    recommendation:
      "Test a contextual link to Reports after the first completed work cycle. Measure first report opens and subsequent repeat use.",
    draft: {
      title: "Introduce Reports after the first completed work cycle",
      priority: "Medium",
      description:
        "Problem\nReports are opened by only 14% of eligible workspace owners in the sample, while repeat use among discoverers is 61%.\n\nHypothesis\nA contextual entry point after a completed cycle may improve discovery.\n\nAcceptance criteria\n• Eligible owners see a Reports entry point after completing their first cycle.\n• The prompt can be dismissed.\n• First opens and next-week report use are measured separately.\n\nSource: SIG-105 · Fictional Signals preview evidence.",
    },
  },
  {
    id: "SIG-104",
    accountId: "acme-posthog",
    projectId: "acme-portal",
    title: "Mobile approvals lose context",
    description:
      "Reviewers switch between the approval and its supporting files.",
    confidence: 82,
    detected: "Oct 25",
    category: "Friction",
    confidenceReason:
      "The pattern is consistent in mobile sessions but the sample is smaller. Device and account differences may explain part of the gap.",
    summary:
      "Mobile reviewers repeatedly leave an approval to read supporting material. Many do not return to finish the decision.",
    finding:
      "Mobile approval completion is 47%, compared with 76% on desktop. Most exits occur after opening a supporting attachment.",
    evidence: [
      "86 mobile review sessions opened an attachment; 39 returned to the approval.",
      "Completion differences persist after filtering to accounts with both mobile and desktop activity.",
    ],
    metrics: [
      { label: "Mobile completion", value: "47%", context: "Desktop: 76%" },
      { label: "Attachment sessions", value: "86", context: "Mobile only" },
      {
        label: "Returned to approval",
        value: "45%",
        context: "39 of 86 sessions",
      },
    ],
    recommendation:
      "Keep the approval context accessible while viewing attachments on mobile. Validate with a small usability check before changing the flow.",
    draft: {
      title: "Keep approval context visible when opening files on mobile",
      priority: "Medium",
      description:
        "Problem\nMobile reviewers often leave an approval to read attachments and do not return. Sample completion is 47%, compared with 76% on desktop.\n\nProposed change\nExplore an attachment preview that preserves a clear path back to the approval.\n\nAcceptance criteria\n• The approval title remains identifiable during attachment viewing.\n• Closing a file restores the previous approval position.\n• Review actions remain reachable with keyboard and touch.\n\nSource: SIG-104 · Fictional Signals preview evidence.",
    },
  },
  {
    id: "SIG-103",
    accountId: "northstar-amplitude",
    projectId: "northstar-portal",
    title: "Saved views bring people back",
    description: "Repeat visits are higher among partners who save a view.",
    confidence: 78,
    detected: "Oct 24",
    category: "Retention",
    confidenceReason:
      "This is a cohort association, not evidence of causation. More engaged partners may be more likely to save views in the first place.",
    summary:
      "Partners who save a view during their first week return more often during the following complete week.",
    finding:
      "Next-week return is 54% for partners who saved a view, compared with 31% for partners who did not. Account size and initial activity may confound this relationship.",
    evidence: [
      "The comparison includes 184 partners who saved a view and 392 who did not.",
      "The difference is smaller among partners with similar first-week activity, suggesting selection effects.",
    ],
    metrics: [
      { label: "Return after saving", value: "54%", context: "184 partners" },
      { label: "Without a saved view", value: "31%", context: "392 partners" },
      { label: "Observation", value: "2 weeks", context: "Complete periods" },
    ],
    recommendation:
      "Test a lightweight saved-view prompt with comparable groups before treating this association as a retention opportunity.",
    draft: {
      title: "Test a contextual prompt to save a partner view",
      priority: "Low",
      description:
        "Observation\nIn the sample, partners who saved a view return more frequently the next week (54% vs. 31%). The association may reflect existing engagement.\n\nProposed experiment\nOffer a contextual save-view prompt to a randomized eligible group.\n\nAcceptance criteria\n• Control and treatment eligibility use the same rules.\n• The prompt is dismissible.\n• Compare next-week return and unwanted prompt interactions.\n\nSource: SIG-103 · Fictional Signals preview evidence.",
    },
  },
]

export function filterSignalInsights(
  insights: Array<SignalInsight>,
  options: {
    status: SignalInsightStatus
    statuses: Record<string, SignalInsightStatus>
    projectId: string
    query: string
    highConfidence: boolean
  }
) {
  const query = options.query.trim().toLowerCase()
  return insights.filter(
    (insight) =>
      (options.statuses[insight.id] ?? "inbox") === options.status &&
      (!options.projectId || insight.projectId === options.projectId) &&
      (!options.highConfidence || insight.confidence >= 85) &&
      (!query ||
        `${insight.title} ${insight.description} ${insight.draft.title}`
          .toLowerCase()
          .includes(query))
  )
}
