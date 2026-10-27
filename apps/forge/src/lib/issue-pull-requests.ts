import { z } from "zod"

export const pullRequestMetadataSchema = z.object({
  status: z.enum(["open", "draft", "merged", "closed"]).optional(),
  author: z
    .object({ name: z.string(), image: z.string().url().optional() })
    .optional(),
  statusChangedAt: z.string().datetime().optional(),
  files: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
})
export type PullRequestMetadata = z.infer<typeof pullRequestMetadataSchema>
type IssueLink = {
  title: string
  url: string
  pullRequest?: PullRequestMetadata
}
export type IssuePullRequest = IssueLink & {
  key: string
  number: number
  repository: string
  provider: "github" | "gitlab"
}

/** Recognize provider URLs without treating arbitrary issue attachments as PRs. */
export function issuePullRequest(link: IssueLink): IssuePullRequest | null {
  try {
    const url = new URL(link.url)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return null
    const github =
      url.hostname === "github.com"
        ? url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/|$)/)
        : null
    // GitLab's /-/merge_requests path also supports self-hosted instances and subgroups.
    const gitlab = url.pathname.match(
      /^\/(.+)\/-\/merge_requests\/([1-9]\d*)(?:\/|$)/
    )
    if (!github && !gitlab) return null
    const repository = github ? `${github[1]}/${github[2]}` : gitlab![1]
    const number = Number(github ? github[3] : gitlab![2])
    if (!Number.isSafeInteger(number)) return null
    const path = github
      ? `/${repository}/pull/${number}`
      : `/${repository}/-/merge_requests/${number}`
    const title = link.title.trim()
    return {
      ...link,
      url: `${url.origin}${path}`,
      key: `${url.origin}${path}`,
      title:
        !title || title === url.hostname ? `${repository}#${number}` : title,
      number,
      repository,
      provider: github ? "github" : "gitlab",
    }
  } catch {
    return null
  }
}

export function issuePullRequests(links: Array<IssueLink>): Array<IssuePullRequest> {
  const requests = new Map<string, IssuePullRequest>()
  for (const link of links) {
    const request = issuePullRequest(link)
    if (!request) continue
    const previous = requests.get(request.key)
    requests.set(
      request.key,
      previous
        ? {
            ...previous,
            pullRequest: { ...previous.pullRequest, ...request.pullRequest },
          }
        : request
    )
  }
  return [...requests.values()]
}
