import { z } from "zod"
import { productStorage } from "@/lib/product-storage"

export const signalEventSchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, "Enter an event name.")
    .max(80)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_.-]*$/,
      "Start with a letter and use only letters, numbers, dots, dashes, or underscores."
    ),
  description: z.string().trim().max(240),
  enabled: z.boolean(),
})
export type SignalEvent = z.infer<typeof signalEventSchema>

export const signalPreferencesSchema = z.object({
  enabled: z.boolean(),
  environment: z.enum(["production", "all"]),
  sampleRate: z.enum(["100", "50", "25", "10"]),
  pageViews: z.boolean(),
  interactions: z.boolean(),
  formSubmissions: z.boolean(),
  errors: z.boolean(),
  performance: z.boolean(),
  respectConsent: z.boolean(),
  excludeInternal: z.boolean(),
  stripQueryParameters: z.boolean(),
  excludedPaths: z.string().max(2000),
  excludedProperties: z.string().max(2000),
  adoption: z.boolean(),
  conversion: z.boolean(),
  retention: z.boolean(),
  friction: z.boolean(),
  instructions: z.string().max(2000),
  events: z
    .array(signalEventSchema)
    .max(100)
    .refine(
      (events) =>
        new Set(events.map((event) => event.name)).size === events.length,
      "Event names must be unique."
    ),
})
export type SignalPreferences = z.infer<typeof signalPreferencesSchema>

export const defaultSignalPreferences: SignalPreferences = {
  enabled: true,
  environment: "production",
  sampleRate: "100",
  pageViews: true,
  interactions: true,
  formSubmissions: false,
  errors: true,
  performance: true,
  respectConsent: true,
  excludeInternal: true,
  stripQueryParameters: true,
  excludedPaths: "/admin/*\n/internal/*",
  excludedProperties: "email\npassword\ntoken",
  adoption: true,
  conversion: true,
  retention: true,
  friction: true,
  instructions: "",
  events: [],
}

export function signalPreferencesStorageKey(
  userId: string,
  workspaceId: string
) {
  return `forge:signals:v1:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`
}

export function readSignalPreferences(
  userId: string,
  workspaceId: string
): SignalPreferences {
  const stored = productStorage.getItem(
    signalPreferencesStorageKey(userId, workspaceId)
  )
  if (!stored) return structuredClone(defaultSignalPreferences)
  // Keep corrupt settings intact so a failed load cannot silently overwrite them.
  return signalPreferencesSchema.parse({
    ...defaultSignalPreferences,
    ...JSON.parse(stored),
  })
}

export function writeSignalPreferences(
  userId: string,
  workspaceId: string,
  preferences: SignalPreferences
) {
  productStorage.setItem(
    signalPreferencesStorageKey(userId, workspaceId),
    JSON.stringify(signalPreferencesSchema.parse(preferences))
  )
}
