import { z } from "zod"

export const callPreferencesSchema = z.object({
  recordingMode: z.enum(["manual", "ask", "automatic"]),
  recordingContent: z.enum(["audio", "audio-video"]),
  language: z.enum(["auto", "en", "fr", "es", "de", "it", "pt", "ja"]),
  speakerLabels: z.boolean(),
  timestamps: z.boolean(),
  removeFillers: z.boolean(),
  generateSummary: z.boolean(),
  summaryFormat: z.enum(["bullets", "paragraphs"]),
  summaryDetail: z.enum(["concise", "detailed"]),
  actionItems: z.boolean(),
  decisions: z.boolean(),
  instructions: z.string().max(2000),
})

export type CallPreferences = z.infer<typeof callPreferencesSchema>

export const defaultCallPreferences: CallPreferences = {
  recordingMode: "manual",
  recordingContent: "audio",
  language: "auto",
  speakerLabels: true,
  timestamps: true,
  removeFillers: true,
  generateSummary: true,
  summaryFormat: "bullets",
  summaryDetail: "concise",
  actionItems: true,
  decisions: true,
  instructions: "",
}

export function callPreferencesStorageKey(userId: string) {
  return `forge:calls-and-transcripts:v1:${userId}`
}

export function readCallPreferences(userId: string): CallPreferences {
  try {
    const stored = window.localStorage.getItem(
      callPreferencesStorageKey(userId)
    )
    const parsed = callPreferencesSchema
      .partial()
      .safeParse(stored ? JSON.parse(stored) : {})
    return parsed.success
      ? { ...defaultCallPreferences, ...parsed.data }
      : { ...defaultCallPreferences }
  } catch {
    return { ...defaultCallPreferences }
  }
}

export function writeCallPreferences(
  userId: string,
  preferences: CallPreferences
) {
  window.localStorage.setItem(
    callPreferencesStorageKey(userId),
    JSON.stringify(callPreferencesSchema.parse(preferences))
  )
}
