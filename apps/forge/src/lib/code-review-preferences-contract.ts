import { z } from "zod"

export const codeReviewPreferencesSchema = z.object({
  issueCodingTool: z.string().max(120),
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
  issueCodingTool: "",
  codeTheme: "forge-dark",
  attachmentFormat: "title",
  startOnBranchCopy: true,
  startOnToolOpen: true,
  pullRequestTool: "github",
  codingTools: ["vscode", "cursor"],
}
