import { z } from "zod"
import type { CallRecord } from "./calls"

const meetings = [
  {
    title: "Weekly product planning",
    provider: "google",
    daysAgo: 0,
    duration: 32,
    participants: ["Maya Chen", "Alex Morgan", "Sam Rivera"],
    summary:
      "The team narrowed this week’s scope to issue drafts, a faster cycle picker, and the Calls recap experience. Draft recovery is the release priority; transcript search will follow once the core flow is reliable.",
    decisions: [
      "Ship draft recovery before adding new composer options.",
      "Keep transcript search scoped to the selected meeting.",
    ],
    actions: [
      "Verify draft recovery when switching teams",
      "Share the cycle picker keyboard spec",
      "Review the Calls recap on a small screen",
    ],
    passages: [
      "Let’s keep this week focused. We have draft recovery, cycle navigation, and the Calls recap competing for time.",
      "Draft recovery should go first. Losing work when switching teams is the biggest interruption in the current flow.",
      "I’ll verify the saved title, description, and attachments across two team switches, then reopen the draft.",
      "For the cycle picker, arrow keys should move through results and Enter should confirm the selected cycle.",
      "Agreed. Share the keyboard spec today so engineering can use the same behavior everywhere.",
      "I’ll review the Calls recap on a small screen. Transcript search can stay within one meeting for this release.",
    ],
    note: "Bring a short recording of the draft recovery flow to the next planning session.",
  },
  {
    title: "Onboarding design review",
    provider: "zoom",
    daysAgo: 0,
    duration: 24,
    participants: ["Alex Morgan", "Nina Patel", "Maya Chen"],
    summary:
      "The onboarding review focused on helping new teams reach their first useful issue sooner. The proposed flow removes an optional setup screen, keeps invitations skippable, and introduces templates after the first issue is created.",
    decisions: [
      "Make team invitations optional during setup.",
      "Introduce templates after the first issue instead of before it.",
    ],
    actions: [
      "Update the onboarding prototype",
      "Recruit five first-time users",
      "Document the first-issue success criteria",
    ],
    passages: [
      "The first useful moment is creating an issue, but we currently ask people to make several setup decisions before they get there.",
      "We can remove the optional preferences screen and let people invite teammates later.",
      "Templates are helpful once someone understands the issue form. I’d introduce them immediately after the first issue.",
      "Let’s test that with five first-time users. We should watch where they hesitate rather than explain the workflow.",
      "I’ll update the prototype and document what counts as a successful first issue before recruitment starts.",
    ],
    note: "Use a fresh workspace in the usability sessions so existing projects do not influence the result.",
  },
  {
    title: "Customer feedback review",
    provider: "teams",
    daysAgo: 1,
    duration: 38,
    participants: ["Sam Rivera", "Nina Patel", "Jordan Lee"],
    summary:
      "Three recurring themes emerged from the sample customer interviews: finding decisions after a meeting, understanding ownership, and keeping follow-ups connected to work. The team agreed to prioritize clear action owners and direct links from recaps to issues.",
    decisions: [
      "Show action owners alongside every suggested follow-up.",
      "Keep the source meeting attached to issues created from a recap.",
    ],
    actions: [
      "Group interview notes by recurring theme",
      "Draft the action-owner interaction",
      "Review issue backlinks with engineering",
    ],
    passages: [
      "Across these interviews, people can find the recording but struggle to find the actual decision.",
      "Ownership is another recurring theme. A useful follow-up needs a clear owner, not just a task title.",
      "The recap already has action items. We can put the owner next to each item and keep the source visible when an issue is created.",
      "That source link matters. People want enough context to check a decision without listening to the entire meeting.",
      "I’ll group the notes by theme and share the action-owner proposal before the next design review.",
    ],
    note: "The interview participants and quotes in this meeting are fictional examples.",
  },
  {
    title: "API performance check-in",
    provider: "google",
    daysAgo: 2,
    duration: 21,
    participants: ["Jordan Lee", "Maya Chen", "Sam Rivera"],
    summary:
      "The engineering check-in identified repeated directory requests as the main source of slow workspace navigation in the test environment. The next pass will reuse cached directory data and measure navigation latency before changing the API contract.",
    decisions: [
      "Reuse cached directory results during client navigation.",
      "Compare the same seeded workspace before and after the change.",
    ],
    actions: [
      "Capture a navigation latency baseline",
      "Deduplicate directory requests",
      "Add a regression check for workspace switching",
    ],
    passages: [
      "The trace shows the directory request repeating during navigation, even when the workspace has not changed.",
      "We should capture a baseline using the same seeded workspace so the comparison is meaningful.",
      "I’ll deduplicate those requests and keep the current API response shape.",
      "Please include a regression check for switching workspaces. Cached data must never cross the workspace boundary.",
      "Once the change is ready, we’ll compare the traces and decide whether further API work is necessary.",
    ],
    note: "Compare request counts as well as latency; a faster request can still hide duplicate work.",
  },
  {
    title: "Release readiness",
    provider: "upload",
    daysAgo: 3,
    duration: 29,
    participants: ["Maya Chen", "Jordan Lee", "Alex Morgan"],
    summary:
      "The release review confirmed that the core issue workflow is ready for the next internal rollout. The team completed the keyboard pass, checked the empty states, and agreed to keep provider integrations behind their existing connection setup.",
    decisions: [
      "Proceed with the internal rollout after the smoke checks.",
      "Keep meeting-provider setup explicit before importing real transcripts.",
    ],
    actions: [
      "Run the release smoke checks",
      "Publish the internal release notes",
      "Confirm the rollback checklist",
    ],
    passages: [
      "The core workflow checks are complete. Issue creation, team switching, and keyboard navigation all passed the internal review.",
      "The empty states are consistent now. We should make sure the release notes explain where to begin when a workspace has no data.",
      "Provider integrations still require connection setup. The rollout must not suggest that an account is connected automatically.",
      "The smoke checks and rollback checklist are complete. I’m ready to proceed with the internal release.",
      "I’ll publish the release notes and keep an eye on the first internal feedback.",
    ],
    note: "Internal rollout checklist completed; review feedback at the next planning meeting.",
  },
  {
    title: "Sprint retrospective",
    provider: "zoom",
    daysAgo: 5,
    duration: 45,
    participants: ["Alex Morgan", "Maya Chen", "Sam Rivera", "Jordan Lee"],
    summary:
      "The team reflected on a sprint with several cross-cutting UI changes. Shared components reduced review time, while late validation caused avoidable rework. The next sprint will include earlier browser checks and smaller, independently reviewable changes.",
    decisions: [
      "Schedule a browser check before the final day of each UI task.",
      "Extract shared controls when a second feature needs the same interaction.",
    ],
    actions: [
      "Add browser verification to the task checklist",
      "Schedule a mid-sprint design review",
      "Collect candidates for shared component cleanup",
    ],
    passages: [
      "Reusing the issue controls saved time once the Reviews page needed the same editing behavior.",
      "The difficult part was validating everything at the end. Small layout problems had already spread to several screens.",
      "Let’s schedule a browser check earlier and keep changes small enough to review independently.",
      "I’d also like a mid-sprint design review. That gives us time to respond to feedback before release day.",
      "Agreed. We’ll update the task checklist and collect shared component cleanup candidates for planning.",
    ],
    note: "Start the next retrospective by checking whether earlier browser reviews reduced rework.",
  },
] as const

function id(teamId: string, number: number) {
  return `${(0xca110000 + number).toString(16)}${teamId.slice(8)}`
}

/** Fictional meetings only; these never create provider connections or server records. */
export function createSimulatedCalls(
  teams: ReadonlyArray<{ id: string }>,
  now = new Date()
): Array<CallRecord> {
  return teams
    .flatMap((team) =>
      meetings.map((meeting, index) => {
        const date = new Date(now)
        for (let days = 0; days < meeting.daysAgo;) {
          date.setDate(date.getDate() - 1)
          if (date.getDay() !== 0 && date.getDay() !== 6) days++
        }
        date.setHours(index === 0 ? 10 : 9, index === 0 ? 30 : 0, 0, 0)
        const startedAt = date.toISOString()
        return {
          id: id(team.id, index + 1),
          teamId: team.id,
          title: meeting.title,
          provider: meeting.provider,
          startedAt,
          duration: meeting.duration,
          participants: [...meeting.participants],
          summary: meeting.summary,
          decisions: [...meeting.decisions],
          transcript: meeting.passages.map((text, passage) => ({
            text,
            speaker:
              meeting.participants[passage % meeting.participants.length],
            seconds:
              18 +
              passage *
                Math.floor((meeting.duration * 60) / meeting.passages.length),
          })),
          status: "ready" as const,
          summaryStatus: "ready" as const,
          actions: meeting.actions.map((title, action) => ({
            id: id(team.id, 100 + index * 10 + action),
            title,
            owner: meeting.participants[action % meeting.participants.length],
            completed: index === 4 || (action === 0 && index > 1),
          })),
          notes: [
            {
              id: id(team.id, 500 + index),
              body: meeting.note,
              kind: "note" as const,
              author: meeting.participants[0],
              createdAt: new Date(
                date.getTime() + meeting.duration * 60_000
              ).toISOString(),
            },
          ],
        }
      })
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

const editSchema = z.object({
  completed: z.array(z.string()),
  notes: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      kind: z.enum(["note", "follow-up"]),
      author: z.string(),
      createdAt: z.string(),
    })
  ),
})
function key(call: CallRecord, creator: string) {
  return `forge:calls-demo:v1:${JSON.stringify([creator, call.teamId, call.id])}`
}
export function readSimulatedCall(
  call: CallRecord,
  creator: string
): CallRecord {
  try {
    const edit = editSchema.parse(
      JSON.parse(localStorage.getItem(key(call, creator)) ?? "null")
    )
    return {
      ...call,
      notes: edit.notes,
      actions: call.actions.map((action) => ({
        ...action,
        completed: edit.completed.includes(action.id),
      })),
    }
  } catch {
    return call
  }
}
export function saveSimulatedCall(call: CallRecord, creator: string) {
  localStorage.setItem(
    key(call, creator),
    JSON.stringify({
      completed: call.actions
        .filter((action) => action.completed)
        .map((action) => action.id),
      notes: call.notes,
    })
  )
}
