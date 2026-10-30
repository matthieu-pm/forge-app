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
