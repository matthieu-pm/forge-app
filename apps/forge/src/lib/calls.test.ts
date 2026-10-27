import { beforeEach, describe, expect, it } from "vitest"
import {
  callDayLabel,
  connectCallSchema,
  importCallSchema,
  parseTranscript,
  timestampLabel,
} from "./calls"
import { createCallIssue } from "./call-issues"
import { readIssueStore } from "./team-issues"
import type { CallRecord } from "./calls"

export const sampleCall: CallRecord = {
  id: "c27aa38f-e45a-4291-87d9-d029c084d369",
  teamId: "862f4136-7535-44ce-8304-dd8784581967",
  title: "Onboarding review",
  provider: "google",
  startedAt: new Date().toISOString(),
  duration: 25,
  participants: ["Alex", "Sam"],
  summary: "The team will test a shorter onboarding flow.",
  decisions: ["Test the shorter flow with five people."],
  transcript: [
    {
      speaker: "Alex",
      seconds: 12,
      text: "Let’s test the shorter onboarding flow.",
    },
    { speaker: "Sam", seconds: 30, text: "I’ll recruit five participants." },
  ],
  status: "ready",
  summaryStatus: "ready",
  actions: [
    {
      id: "f2b89a9f-7bc1-4137-be56-1f915c6ef4f2",
      title: "Recruit five participants",
      owner: "Sam",
      completed: false,
    },
  ],
  notes: [],
}
beforeEach(() => localStorage.clear())
describe("native transcript normalization", () => {
  it("keeps timestamps, speakers and multiline text from VTT and SRT", () => {
    expect(
      parseTranscript(
        "WEBVTT\n\n00:00:12.500 --> 00:00:18.000\n<v Alex>Let’s test\nthe shorter flow.</v>\n\n2\n00:01:02,000 --> 00:01:05,000\nSam: I’ll recruit five people."
      )
    ).toEqual([
      { speaker: "Alex", seconds: 12, text: "Let’s test the shorter flow." },
      { speaker: "Sam", seconds: 62, text: "I’ll recruit five people." },
    ])
    expect(timestampLabel(3661)).toBe("61:01")
  })
  it("rejects empty VTT and preserves colons inside a labelled speaker’s passage", () => {
    expect(parseTranscript("WEBVTT\n\n")).toEqual([])
    expect(
      parseTranscript(
        "WEBVTT\n\n00:00:12.000 --> 00:00:15.000\n<v Alex>Decision: keep it small.</v>"
      )[0]
    ).toEqual({
      speaker: "Alex",
      seconds: 12,
      text: "Decision: keep it small.",
    })
  })
  it("parses speaker-labelled text without fabricating timestamps", () => {
    expect(
      parseTranscript("Alex: Keep the scope small.\nSam: Agreed.")
    ).toEqual([
      { speaker: "Alex", seconds: 0, text: "Keep the scope small." },
      { speaker: "Sam", seconds: 0, text: "Agreed." },
    ])
  })
  it("requires explicit participant-notice acknowledgement before import or connect", () => {
    expect(
      importCallSchema.safeParse({
        teamId: sampleCall.teamId,
        title: "Review",
        startedAt: sampleCall.startedAt,
        text: "Alex: Hi",
        consentConfirmed: false,
      }).success
    ).toBe(false)
    expect(
      connectCallSchema.safeParse({
        teamId: sampleCall.teamId,
        provider: "google",
      }).success
    ).toBe(false)
  })
  it("groups calls by local calendar day across month boundaries", () => {
    expect(
      callDayLabel(
        new Date(2026, 8, 30, 15).toISOString(),
        new Date(2026, 9, 1, 12)
      )
    ).toBe("Yesterday")
  })
})
describe("call action to Forge issue", () => {
  it("creates one issue per action with a durable call backlink and preserves the mentioned owner as context", () => {
    const first = createCallIssue(
      sampleCall,
      sampleCall.actions[0],
      "http://localhost:3000",
      "user-1"
    )
    const second = createCallIssue(
      sampleCall,
      sampleCall.actions[0],
      "http://localhost:3000",
      "user-1"
    )
    expect(second.id).toBe(first.id)
    expect(readIssueStore(sampleCall.teamId).issues).toHaveLength(1)
    expect(first.links[0].url).toContain(
      `call=${sampleCall.id}#action-${sampleCall.actions[0].id}`
    )
    expect(first.description).toContain("Mentioned owner: Sam")
    expect(first.assignee).toBeFalsy()
    expect(first.creator).toBe("user-1")
  })
})
