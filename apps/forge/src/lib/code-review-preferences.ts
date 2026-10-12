import { z } from "zod"

export const codeReviewPreferencesSchema = z.object({
  codeTheme: z.enum(["forge-dark", "github-dark", "github-light"]),
  attachmentFormat: z.enum(["title", "title-and-number", "number"]),
  startOnBranchCopy: z.boolean(),
  startOnToolOpen: z.boolean(),
  pullRequestTool: z.enum(["github", "browser"]),
  codingTools: z.array(
    z.enum(["vscode", "cursor", "windsurf", "zed", "terminal"])
  ),
})
export type CodeReviewPreferences = z.infer<typeof codeReviewPreferencesSchema>
export const defaultCodeReviewPreferences: CodeReviewPreferences = {
  codeTheme: "forge-dark",
  attachmentFormat: "title",
  startOnBranchCopy: true,
  startOnToolOpen: true,
  pullRequestTool: "github",
  codingTools: ["vscode", "cursor"],
}
export function codeReviewStorageKey(userId: string) {
  return `forge:code-reviews:${userId}`
}
export function readCodeReviewPreferences(
  userId: string
): CodeReviewPreferences {
  try {
    const stored = window.localStorage.getItem(codeReviewStorageKey(userId))
    const parsed = codeReviewPreferencesSchema
      .partial()
      .safeParse(stored ? JSON.parse(stored) : {})
    return parsed.success
      ? { ...defaultCodeReviewPreferences, ...parsed.data }
      : { ...defaultCodeReviewPreferences }
  } catch {
    return { ...defaultCodeReviewPreferences }
  }
}
export function writeCodeReviewPreferences(
  userId: string,
  preferences: CodeReviewPreferences
) {
  window.localStorage.setItem(
    codeReviewStorageKey(userId),
    JSON.stringify(codeReviewPreferencesSchema.parse(preferences))
  )
}
