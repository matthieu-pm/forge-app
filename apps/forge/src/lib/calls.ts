import { z } from "zod"

export const meetingProviderSchema = z.enum(["google", "teams", "zoom"])
export type MeetingProvider = z.infer<typeof meetingProviderSchema>
export const meetingProviders = {
  google: {
    name: "Google Meet",
    logo: "/img/integrations/google-meet.svg",
    help: "Enable transcription in Google Meet. Forge imports completed conference transcripts from your connected account.",
  },
  teams: {
    name: "Microsoft Teams",
    logo: "/img/integrations/microsoft-teams.svg",
    help: "Enable transcription in Teams. Your Microsoft tenant must allow access to meeting transcripts.",
  },
  zoom: {
    name: "Zoom",
    logo: "/img/integrations/zoom.svg",
    help: "Enable cloud recording and audio transcripts in Zoom. Forge imports the completed transcript.",
  },
} as const
export const transcriptEntrySchema = z.object({
  speaker: z.string().max(200),
  seconds: z.number().nonnegative(),
  text: z.string().max(20000),
})
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>
export const recapSchema = z.object({
  summary: z.string().max(8000),
  decisions: z.array(z.string().max(2000)).max(50),
  actions: z
    .array(
      z.object({
        title: z.string().min(1).max(240),
        owner: z.string().max(200),
      })
    )
    .max(50),
})
export type CallRecap = z.infer<typeof recapSchema>
export type CallAction = {
  id: string
  title: string
  owner: string
  completed: boolean
}
export type CallNote = {
  id: string
  body: string
  kind: "note" | "follow-up"
  author: string
  createdAt: string
}
export type CallRecord = {
  id: string
  teamId: string
  title: string
  provider: MeetingProvider | "upload"
  startedAt: string
  duration: number
  participants: Array<string>
  summary: string
  decisions: Array<string>
  transcript: Array<TranscriptEntry>
  status: "pending" | "ready" | "error" | "expired"
  summaryStatus: "pending" | "ready" | "error"
  actions: Array<CallAction>
  notes: Array<CallNote>
}
export type CallConnection = {
  id: string
  provider: MeetingProvider
  teamId: string
  connected: boolean
  lastSyncedAt: string | null
  error: string | null
  isOwner: boolean
}
export type CallsDirectory = {
  calls: Array<CallRecord>
  connections: Array<CallConnection>
  canManage: boolean
  retentionDays: number
  configuredProviders: Array<MeetingProvider>
}
export const callIdSchema = z.object({ callId: z.string().uuid() })
export const importCallSchema = z.object({
  teamId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  startedAt: z.string().datetime(),
  text: z.string().trim().min(1).max(250000),
  consentConfirmed: z.literal(true),
})
export const connectCallSchema = z.object({
  provider: meetingProviderSchema,
  teamId: z.string().uuid(),
  consentConfirmed: z.literal(true),
})
export const noteInputSchema = callIdSchema.extend({
  body: z.string().trim().min(1).max(10000),
  kind: z.enum(["note", "follow-up"]),
})
export const retentionInputSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]),
})

export function timestampLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
}
export function parseTranscript(raw: string): Array<TranscriptEntry> {
  const text = raw.replace(/\r/g, "").replace(/^\uFEFF/, "")
  const blocks = text.split(/\n\s*\n/)
  const entries: Array<TranscriptEntry> = []
  for (const block of blocks) {
    const lines = block.split("\n")
    const timeIndex = lines.findIndex((line) => line.includes("-->"))
    if (timeIndex < 0) continue
    const match = lines[timeIndex].match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d+)/)
    if (!match) continue
    const body = lines
      .slice(timeIndex + 1)
      .join(" ")
      .trim()
    const voice = body.match(/^<v\s+([^>]+)>([\s\S]*)/)
    const plain = (voice?.[2] ?? body)
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
    const named = voice ? null : plain.match(/^([^:]{1,100}):\s+([\s\S]+)/)
    entries.push({
      speaker: voice?.[1] ?? named?.[1] ?? "Speaker",
      seconds:
        Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]),
      text: named?.[2] ?? plain,
    })
  }
  if (entries.length) return entries.filter((entry) => entry.text.trim())
  if (/^WEBVTT(?:\s|$)/.test(text.trim()) || text.includes("-->")) return []
  return text
    .split(/\n+/)
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.match(/^([^:]{1,100}):\s+(.+)/)
      return {
        speaker: match?.[1] ?? "Speaker",
        seconds: 0,
        text: match?.[2] ?? line,
      }
    })
}
export function callMatches(call: CallRecord, query: string) {
  return [
    call.title,
    call.summary,
    ...call.participants,
    ...call.actions.map((action) => action.title),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query.toLowerCase().trim())
}
export function callDayLabel(iso: string, now = new Date()) {
  const date = new Date(iso)
  if (date.toDateString() === now.toDateString()) return "Today"
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear()
      ? { year: "numeric" as const }
      : {}),
  })
}
