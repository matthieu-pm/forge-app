import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  authorizationUrl,
  exchangeTokens,
  fetchNativeCalls,
} from "./providers.server"

const fetcher = vi.fn()
const response = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200 })
beforeEach(() => {
  vi.stubGlobal("fetch", fetcher)
  fetcher.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
describe("native meeting adapters", () => {
  it("paginates Google entries and resolves speaker names", async () => {
    fetcher
      .mockResolvedValueOnce(
        response({
          conferenceRecords: [
            {
              name: "conferenceRecords/c1",
              startTime: "2026-10-24T10:00:00Z",
              endTime: "2026-10-24T10:30:00Z",
              space: "spaces/abc",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        response({
          transcripts: [
            {
              name: "conferenceRecords/c1/transcripts/t1",
              state: "FILE_GENERATED",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        response({
          participants: [{ name: "p1", signedinUser: { displayName: "Alex" } }],
        })
      )
      .mockResolvedValueOnce(
        response({
          transcriptEntries: [
            {
              participant: "p1",
              startTime: "2026-10-24T10:00:12Z",
              text: "Ship the small pilot.",
            },
          ],
          nextPageToken: "page2",
        })
      )
      .mockResolvedValueOnce(
        response({
          transcriptEntries: [
            {
              participant: "p1",
              startTime: "2026-10-24T10:01:00Z",
              text: "I will prepare it.",
            },
          ],
        })
      )
    const result = await fetchNativeCalls(
      "google",
      "test-token",
      new Date("2026-10-23")
    )
    expect(result[0].transcript).toEqual([
      { speaker: "Alex", seconds: 12, text: "Ship the small pilot." },
      { speaker: "Alex", seconds: 60, text: "I will prepare it." },
    ])
    expect(fetcher.mock.calls[4][0]).toContain("pageToken=page2")
    expect(result[0].participants).toEqual(["Alex"])
  })
  it("keeps recurring Teams transcripts in their own calendar occurrence", async () => {
    const events = ["2026-10-23", "2026-10-24"].map((date, index) => ({
      id: `event-${index}`,
      subject: "Daily sync",
      isOrganizer: true,
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/meeting" },
      start: { dateTime: `${date}T10:00:00` },
      end: { dateTime: `${date}T10:30:00` },
      attendees: [],
    }))
    const artifacts = {
      value: [
        { id: "t1", createdDateTime: "2026-10-23T10:05:00Z" },
        { id: "t2", createdDateTime: "2026-10-24T10:05:00Z" },
      ],
    }
    fetcher
      .mockResolvedValueOnce(response({ value: events }))
      .mockResolvedValueOnce(response({ value: [{ id: "recurring-meeting" }] }))
      .mockResolvedValueOnce(response(artifacts))
      .mockResolvedValueOnce(
        new Response(
          "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alex>First day.</v>"
        )
      )
      .mockResolvedValueOnce(response({ value: [{ id: "recurring-meeting" }] }))
      .mockResolvedValueOnce(response(artifacts))
      .mockResolvedValueOnce(
        new Response(
          "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alex>Second day.</v>"
        )
      )
    const result = await fetchNativeCalls(
      "teams",
      "test-token",
      new Date("2026-10-22")
    )
    expect(
      result.map((call) => call.transcript.map((entry) => entry.text))
    ).toEqual([["First day."], ["Second day."]])
    expect(result.map((call) => call.startedAt.toISOString())).toEqual([
      "2026-10-23T10:00:00.000Z",
      "2026-10-24T10:00:00.000Z",
    ])
    expect(result[0].externalId).not.toBe(result[1].externalId)
  })
  it("normalizes Zoom VTT without downloading audio or video", async () => {
    fetcher
      .mockResolvedValueOnce(
        response({
          meetings: [
            {
              uuid: "meeting-1",
              topic: "Review",
              start_time: "2026-10-24T10:00:00Z",
              duration: 20,
              recording_files: [
                {
                  recording_type: "audio_only",
                  status: "completed",
                  download_url: "https://us02web.zoom.us/audio",
                },
                {
                  recording_type: "audio_transcript",
                  status: "completed",
                  download_url: "https://us02web.zoom.us/transcript",
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        new Response(
          "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nAlex: Let’s do it."
        )
      )
    const result = await fetchNativeCalls(
      "zoom",
      "test-token",
      new Date("2026-10-23")
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result[0].transcript[0]).toEqual({
      speaker: "Alex",
      seconds: 10,
      text: "Let’s do it.",
    })
  })
  it("does not send bearer tokens to unsupported transcript download hosts", async () => {
    fetcher.mockResolvedValueOnce(
      response({
        meetings: [
          {
            recording_files: [
              {
                recording_type: "audio_transcript",
                status: "completed",
                download_url: "http://127.0.0.1/private",
              },
            ],
          },
        ],
      })
    )
    await expect(
      fetchNativeCalls("zoom", "test-token", new Date("2026-10-23"))
    ).rejects.toThrow("unsupported transcript location")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("uses PKCE and carries the exact callback and state to Google", () => {
    vi.stubEnv("FORGE_GOOGLE_MEET_CLIENT_ID", "client-id")
    vi.stubEnv("FORGE_GOOGLE_MEET_CLIENT_SECRET", "test-secret")
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
    const url = new URL(authorizationUrl("google", "state-1", "challenge-1"))
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/calls/oauth/callback"
    )
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1")
    expect(url.searchParams.get("access_type")).toBe("offline")
  })
  it("keeps the refresh token if the provider returns only a new access token", async () => {
    vi.stubEnv("FORGE_ZOOM_CLIENT_ID", "client-id")
    vi.stubEnv("FORGE_ZOOM_CLIENT_SECRET", "test-secret")
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
    fetcher.mockResolvedValue(
      response({ access_token: "new-test-token", expires_in: 3600 })
    )
    expect(
      (await exchangeTokens("zoom", { refreshToken: "refresh-token" }))
        .refresh_token
    ).toBe("refresh-token")
  })
})
