import "@tanstack/react-start/server-only"
import { assertStagingEnvironment } from "../../../../../packages/environment/staging-environment"
import { selectedCallProviders } from "../../../../../packages/environment/service-config"
import type { MeetingProvider, TranscriptEntry } from "@/lib/calls"
import { parseTranscript } from "@/lib/calls"

export type MeetingTokens = {
  access_token: string
  refresh_token?: string
  expires_at: number
}
export type NativeCall = {
  externalId: string
  title: string
  startedAt: Date
  duration: number
  participants: Array<string>
  transcript: Array<TranscriptEntry>
}
const providerConfig = {
  google: {
    prefix: "GOOGLE_MEET",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/meetings.space.readonly",
  },
  teams: {
    prefix: "MICROSOFT_TEAMS",
    authorize:
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    scope:
      "offline_access User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All",
  },
  zoom: {
    prefix: "ZOOM",
    authorize: "https://zoom.us/oauth/authorize",
    token: "https://zoom.us/oauth/token",
    scope: "",
  },
} as const
export function configuredProviders() {
  return (Object.keys(providerConfig) as Array<MeetingProvider>).filter(
    (provider) => {
      if (!selectedCallProviders(process.env).includes(provider)) return false
      const prefix = providerConfig[provider].prefix
      return Boolean(
        process.env[`FORGE_${prefix}_CLIENT_ID`] &&
        process.env[`FORGE_${prefix}_CLIENT_SECRET`] &&
        process.env.FORGE_MODEL_CREDENTIAL_KEK &&
        process.env.BETTER_AUTH_URL
      )
    }
  )
}
function config(provider: MeetingProvider) {
  assertStagingEnvironment(process.env, "web")
  if (!selectedCallProviders(process.env).includes(provider))
    throw new Error("This meeting provider is not enabled for this deployment.")
  const item = providerConfig[provider]
  const clientId = process.env[`FORGE_${item.prefix}_CLIENT_ID`]
  const clientSecret = process.env[`FORGE_${item.prefix}_CLIENT_SECRET`]
  const origin = process.env.BETTER_AUTH_URL
  if (!clientId || !clientSecret || !origin)
    throw new Error(
      "This meeting provider needs to be configured by your Forge administrator."
    )
  return {
    ...item,
    clientId,
    clientSecret,
    redirectUri: new URL("/api/calls/oauth/callback", origin).href,
  }
}
export function authorizationUrl(
  provider: MeetingProvider,
  state: string,
  challenge: string
) {
  const item = config(provider)
  const url = new URL(item.authorize)
  const params: Record<string, string> = {
    client_id: item.clientId,
    redirect_uri: item.redirectUri,
    response_type: "code",
    state,
  }
  if (item.scope) params.scope = item.scope
  if (provider !== "zoom") {
    params.code_challenge = challenge
    params.code_challenge_method = "S256"
  }
  if (provider === "google") {
    params.access_type = "offline"
    params.prompt = "consent"
  }
  url.search = new URLSearchParams(params).toString()
  return url.href
}
export async function exchangeTokens(
  provider: MeetingProvider,
  input: { code: string; verifier: string } | { refreshToken: string }
): Promise<MeetingTokens> {
  const item = config(provider)
  const body = new URLSearchParams(
    "code" in input
      ? {
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: item.redirectUri,
          ...(provider !== "zoom" ? { code_verifier: input.verifier } : {}),
        }
      : { grant_type: "refresh_token", refresh_token: input.refreshToken }
  )
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  }
  if (provider === "zoom")
    headers.authorization = `Basic ${Buffer.from(`${item.clientId}:${item.clientSecret}`).toString("base64")}`
  else {
    body.set("client_id", item.clientId)
    body.set("client_secret", item.clientSecret)
  }
  const response = await fetch(item.token, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok)
    throw new Error(
      "Meeting authorization expired or was denied. Reconnect your account."
    )
  const data = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.access_token)
    throw new Error("The meeting provider did not return an access token.")
  return {
    access_token: data.access_token,
    refresh_token:
      data.refresh_token ??
      ("refreshToken" in input ? input.refreshToken : undefined),
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}
async function api(
  url: string,
  token: string,
  format: "json" | "text" = "json"
): Promise<any> {
  const parsed = new URL(url)
  if (
    parsed.protocol !== "https:" ||
    !(
      ["meet.googleapis.com", "graph.microsoft.com", "api.zoom.us"].includes(
        parsed.hostname
      ) ||
      parsed.hostname === "zoom.us" ||
      parsed.hostname.endsWith(".zoom.us")
    )
  )
    throw new Error("The provider returned an unsupported transcript location.")
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? "The meeting provider denied transcript access. Check account permissions and transcription settings."
        : "The meeting provider could not be reached. Try syncing again."
    )
  const raw = await response.text()
  if (raw.length > 2000000)
    throw new Error("The meeting transcript exceeds the import limit.")
  return format === "text" ? raw : JSON.parse(raw)
}
async function pages(
  url: string,
  token: string,
  key: string,
  mode: "google" | "teams" | "zoom"
) {
  const result: Array<any> = []
  let next = url
  for (let page = 0; page < 100 && next; page++) {
    const data = await api(next, token)
    result.push(...(data[key] ?? []))
    const cursor = data.nextPageToken ?? data.next_page_token
    if (mode === "teams") next = data["@odata.nextLink"] ?? ""
    else if (cursor) {
      const u = new URL(url)
      u.searchParams.set(
        mode === "zoom" ? "next_page_token" : "pageToken",
        cursor
      )
      next = u.href
    } else next = ""
  }
  if (next)
    throw new Error(
      "Too many meeting records. Narrow the synchronization window."
    )
  return result
}
export async function fetchNativeCalls(
  provider: MeetingProvider,
  token: string,
  since: Date
): Promise<Array<NativeCall>> {
  if (provider === "google") {
    const base = "https://meet.googleapis.com/v2/"
    const records = await pages(
      `${base}conferenceRecords?filter=${encodeURIComponent(`start_time >= "${since.toISOString()}"`)}&pageSize=100`,
      token,
      "conferenceRecords",
      "google"
    )
    const result: Array<NativeCall> = []
    for (const record of records) {
      if (!record.endTime) continue
      const transcripts = await pages(
        `${base}${record.name}/transcripts?pageSize=100`,
        token,
        "transcripts",
        "google"
      )
      if (
        !transcripts.length ||
        transcripts.some((item) => item.state !== "FILE_GENERATED")
      )
        continue
      const people = await pages(
        `${base}${record.name}/participants?pageSize=100`,
        token,
        "participants",
        "google"
      )
      const names = new Map(
        people.map((p) => [
          p.name,
          p.signedinUser?.displayName ??
            p.anonymousUser?.displayName ??
            p.phoneUser?.displayName ??
            "Participant",
        ])
      )
      const entries: Array<TranscriptEntry> = []
      for (const transcript of transcripts) {
        const items = await pages(
          `${base}${transcript.name}/entries?pageSize=100`,
          token,
          "transcriptEntries",
          "google"
        )
        entries.push(
          ...items.map((e) => ({
            speaker: names.get(e.participant) ?? "Participant",
            seconds: Math.max(
              0,
              (Date.parse(e.startTime) - Date.parse(record.startTime)) / 1000
            ),
            text: e.text,
          }))
        )
      }
      result.push({
        externalId: record.name,
        title: `Meet · ${record.space?.split("/").at(-1) ?? "Team conversation"}`,
        startedAt: new Date(record.startTime),
        duration: Math.round(
          (Date.parse(record.endTime) - Date.parse(record.startTime)) / 60000
        ),
        participants: [...names.values()],
        transcript: entries.sort((a, b) => a.seconds - b.seconds),
      })
    }
    return result
  }
  if (provider === "teams") {
    const base = "https://graph.microsoft.com/v1.0"
    const events = await pages(
      `${base}/me/calendarView?startDateTime=${encodeURIComponent(since.toISOString())}&endDateTime=${encodeURIComponent(new Date().toISOString())}&$top=100`,
      token,
      "value",
      "teams"
    )
    const result: Array<NativeCall> = []
    for (const event of events) {
      if (
        !event.onlineMeeting?.joinUrl ||
        event.isCancelled ||
        event.isOrganizer === false
      )
        continue
      const filter = encodeURIComponent(
        `JoinWebUrl eq '${event.onlineMeeting.joinUrl.replace(/'/g, "''")}'`
      )
      const meetings = await api(
        `${base}/me/onlineMeetings?$filter=${filter}`,
        token
      )
      for (const meeting of meetings.value ?? []) {
        const root = `${base}/me/onlineMeetings/${encodeURIComponent(meeting.id)}`
        const transcripts = await pages(
          `${root}/transcripts`,
          token,
          "value",
          "teams"
        )
        const asUtc = (value: string) =>
          new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`)
        const startedAt = asUtc(event.start.dateTime)
        const endedAt = asUtc(event.end.dateTime)
        const entries: Array<TranscriptEntry> = []
        // Recurring events share an onlineMeeting ID. Keep artifacts in their occurrence.
        const occurrenceTranscripts = transcripts.filter((t) => {
          const created = Date.parse(t.createdDateTime)
          return (
            created >= startedAt.getTime() - 60000 &&
            created <= endedAt.getTime() + 15 * 60000
          )
        })
        for (const t of occurrenceTranscripts)
          entries.push(
            ...parseTranscript(
              await api(
                `${root}/transcripts/${encodeURIComponent(t.id)}/content?$format=text/vtt`,
                token,
                "text"
              )
            )
          )
        if (entries.length)
          result.push({
            externalId: `${meeting.id}:${event.id}`,
            title: event.subject || "Teams conversation",
            startedAt,
            duration: Math.max(
              0,
              Math.round((endedAt.getTime() - startedAt.getTime()) / 60000)
            ),
            participants: [
              ...new Set(
                [
                  event.organizer?.emailAddress?.name,
                  ...(event.attendees ?? []).map(
                    (a: any) => a.emailAddress?.name
                  ),
                ].filter(Boolean)
              ),
            ] as Array<string>,
            transcript: entries,
          })
      }
    }
    return result
  }
  const meetings = await pages(
    `https://api.zoom.us/v2/users/me/recordings?from=${since.toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}&page_size=100`,
    token,
    "meetings",
    "zoom"
  )
  const result: Array<NativeCall> = []
  for (const meeting of meetings) {
    const files = (meeting.recording_files ?? []).filter(
      (file: any) =>
        file.recording_type === "audio_transcript" &&
        file.status === "completed"
    )
    const entries: Array<TranscriptEntry> = []
    for (const file of files)
      entries.push(
        ...parseTranscript(await api(file.download_url, token, "text"))
      )
    if (entries.length)
      result.push({
        externalId: meeting.uuid,
        title: meeting.topic || "Zoom conversation",
        startedAt: new Date(meeting.start_time),
        duration: meeting.duration ?? 0,
        participants: [...new Set(entries.map((e) => e.speaker))],
        transcript: entries,
      })
  }
  return result
}
