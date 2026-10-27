import type { Review } from "./reviews-view"

/** Fictional pull requests for the Reviews preview. Never sent to GitHub. */
export function createSimulatedReviews(
  user: { id: string; name: string | null },
  now = Date.now()
): Array<Review> {
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString()
  const you = { id: user.id, name: user.name || "You" }
  const maya = { id: "reviews-demo:maya", name: "Maya Chen" }
  const leo = { id: "reviews-demo:leo", name: "Leo Martin" }
  const amira = { id: "reviews-demo:amira", name: "Amira Hassan" }
  const nora = { id: "reviews-demo:nora", name: "Nora Kim" }
  const make = (
    number: number,
    title: string,
    description: string,
    changes: Partial<Review>
  ): Review => ({
    id: `reviews-demo:${number}`,
    number,
    title,
    description,
    repository: "forge/web",
    author: maya,
    reviewerIds: [],
    participatedUserIds: [],
    teamReview: false,
    status: "open",
    reviewState: "requested",
    labels: [],
    openedAt: ago(48),
    updatedAt: ago(2),
    closedAt: null,
    url: "",
    ...changes,
  })
  return [
    make(
      248,
      "Keep issue drafts when switching teams",
      "Summary\nPreserves an unfinished issue when someone moves between teams in the composer. Drafts are restored with their original title, description, and attachments.\n\nChanges\n• Scope saved drafts to the workspace and author.\n• Restore the selected team when reopening a draft.\n• Keep keyboard focus in the title field.\n\nReview focus\nCheck that switching teams twice restores the correct draft without carrying over team-specific labels.",
      {
        author: maya,
        reviewerIds: [user.id],
        labels: ["bug", "issues"],
        updatedAt: ago(0.3),
      }
    ),
    make(
      246,
      "Add keyboard navigation to the cycle picker",
      "Summary\nMakes cycle assignment accessible without a mouse. Arrow keys move between cycles, Enter confirms, and Escape returns focus to the issue property.\n\nChanges\n• Reuse the shared command menu.\n• Announce the currently selected cycle.\n• Scroll the active option into view.\n\nReview focus\nTry the picker with a long list and verify that disabled cycles cannot be selected.",
      {
        author: leo,
        reviewerIds: [user.id],
        labels: ["accessibility"],
        updatedAt: ago(1.5),
        openedAt: ago(30),
      }
    ),
    make(
      89,
      "Retry transient failures when importing transcripts",
      "Summary\nRetries temporary provider errors during transcript imports while avoiding duplicate call records.\n\nChanges\n• Add a bounded retry schedule for timeouts and rate limits.\n• Reuse the existing import identifier for each attempt.\n• Surface a clear failure message after the final retry.\n\nReview focus\nConfirm that a successful retry creates one call and retains its original provider link.",
      {
        repository: "forge/integrations",
        author: amira,
        reviewerIds: [user.id],
        labels: ["calls", "reliability"],
        updatedAt: ago(3),
        openedAt: ago(60),
      }
    ),
    make(
      243,
      "Unify empty states across workspace views",
      "Summary\nUses the shared empty-state layout for Projects, Views, and Initiatives.\n\nChanges\n• Align illustration spacing and heading sizes.\n• Reuse the primary action button.\n• Keep the layout readable on smaller screens.\n\nFeedback to address\nThe mobile illustration still pushes the primary action below the fold on short screens. Reduce its height and check the spacing at 390 px wide.",
      {
        author: you,
        reviewState: "changes-requested",
        labels: ["design", "workspace"],
        updatedAt: ago(0.8),
        openedAt: ago(72),
      }
    ),
    make(
      241,
      "Persist review display preferences",
      "Summary\nRemembers grouping, ordering, and visible properties for each person in a workspace.\n\nChanges\n• Validate saved preferences before restoring them.\n• Keep the For you and Created views in sync.\n• Fall back to defaults when browser storage is unavailable.\n\nReview status\nReady for another pass after the storage fallback changes.",
      {
        author: you,
        reviewState: "approved",
        labels: ["reviews"],
        updatedAt: ago(4),
        openedAt: ago(80),
      }
    ),
    make(
      83,
      "Validate webhook payloads before queueing imports",
      "Summary\nChecks incoming integration events before adding them to the import queue.\n\nChanges\n• Reject unsupported event types.\n• Record a stable delivery identifier.\n• Skip duplicate deliveries.\n\nReview focus\nThe platform team has been requested to review the queue boundary and error handling.",
      {
        repository: "forge/integrations",
        author: nora,
        teamReview: true,
        labels: ["platform"],
        updatedAt: ago(5),
        openedAt: ago(96),
      }
    ),
    make(
      237,
      "Improve project search relevance",
      "Summary\nRanks exact project-name matches before description-only matches and keeps recent projects near the top.\n\nChanges\n• Normalize whitespace in search terms.\n• Preserve the current filter when clearing a search.\n• Add an empty result message with a reset action.\n\nDiscussion\nYou previously suggested keeping archived projects out of the default results. That change is included in this revision.",
      {
        author: maya,
        participatedUserIds: [user.id],
        reviewState: "reviewed",
        labels: ["search"],
        updatedAt: ago(7),
        openedAt: ago(100),
      }
    ),
    make(
      235,
      "Explore a compact call recap layout",
      "Summary\nAn early layout experiment for call recaps with many action items.\n\nProposed layout\n• Keep the summary and participants above the fold.\n• Group action items by owner.\n• Collapse the transcript until it is needed.\n\nStill to do\nCheck long participant names and the narrow-screen layout before requesting a review.",
      {
        author: you,
        status: "draft",
        reviewState: "reviewed",
        labels: ["design", "calls"],
        updatedAt: ago(8),
        openedAt: ago(110),
      }
    ),
    make(
      232,
      "Fix sidebar disclosure after workspace changes",
      "Summary\nRestores the correct sidebar sections when switching between workspaces.\n\nChanges\n• Scope disclosure state to each workspace.\n• Preserve expanded team sections during client navigation.\n• Restore the default layout for a newly joined workspace.\n\nOutcome\nApproved and merged after the navigation checks passed.",
      {
        author: you,
        status: "merged",
        reviewState: "approved",
        labels: ["bug", "navigation"],
        updatedAt: ago(10),
        closedAt: ago(10),
        openedAt: ago(120),
      }
    ),
    make(
      76,
      "Remove the legacy transcript import path",
      "Summary\nRemoves the old import handler after the new provider adapter rollout.\n\nOutcome\nClosed while the team verifies support for older provider payloads. The existing adapter remains in place.",
      {
        repository: "forge/integrations",
        author: leo,
        participatedUserIds: [user.id],
        status: "closed",
        reviewState: "reviewed",
        labels: ["maintenance"],
        updatedAt: ago(18),
        closedAt: ago(18),
        openedAt: ago(168),
      }
    ),
    make(
      219,
      "Standardize settings breadcrumbs",
      "Summary\nMoves account and workspace settings onto the shared breadcrumb header.\n\nChanges\n• Keep the header fixed while settings content scrolls.\n• Use consistent labels and spacing.\n• Preserve navigation history between settings pages.\n\nOutcome\nMerged earlier this week. Change Closed reviews to Past week or All time to include it in the list.",
      {
        author: nora,
        participatedUserIds: [user.id],
        status: "merged",
        reviewState: "approved",
        labels: ["settings"],
        updatedAt: ago(80),
        closedAt: ago(80),
        openedAt: ago(200),
      }
    ),
  ]
}
