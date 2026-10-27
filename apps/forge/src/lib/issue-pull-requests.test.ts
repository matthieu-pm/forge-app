import { describe, expect, it } from "vitest"
import { issuePullRequest, issuePullRequests } from "./issue-pull-requests"
import {
  blankIssueDraft,
  defaultIssueDisplay,
  displaySchema,
  issueDraftSchema,
} from "./team-issues"

describe("linked pull requests", () => {
  it("recognizes GitHub pull requests and canonicalizes diff links", () => {
    expect(
      issuePullRequest({
        title: "Fix invites",
        url: "https://github.com/acme/web/pull/12/files?diff=split#file",
      })
    ).toMatchObject({
      number: 12,
      repository: "acme/web",
      provider: "github",
      url: "https://github.com/acme/web/pull/12",
    })
  })
  it("recognizes GitLab subgroups and self-hosted merge requests", () => {
    expect(
      issuePullRequest({
        title: "git.example.com",
        url: "https://git.example.com/acme/product/web/-/merge_requests/3",
      })
    ).toMatchObject({
      number: 3,
      repository: "acme/product/web",
      title: "acme/product/web#3",
      provider: "gitlab",
    })
  })
  it("leaves unrelated, malformed, unsafe, and zero-number links alone", () => {
    for (const url of [
      "https://github.com/acme/web/issues/1",
      "https://example.com/acme/web/pull/1",
      "javascript:alert(1)",
      "not a url",
      "https://github.com/acme/web/pull/0",
      "https://user:password@github.com/acme/web/pull/1",
    ])
      expect(issuePullRequest({ title: "Link", url })).toBeNull()
  })
  it("deduplicates links while retaining known PR metadata", () => {
    expect(
      issuePullRequests([
        {
          title: "Fix invites",
          url: "https://github.com/acme/web/pull/12",
          pullRequest: { status: "merged", additions: 24 },
        },
        {
          title: "Diff",
          url: "https://github.com/acme/web/pull/12/files",
          pullRequest: { deletions: 2 },
        },
        { title: "Docs", url: "https://example.com" },
      ])
    ).toMatchObject([
      {
        title: "Fix invites",
        pullRequest: { status: "merged", additions: 24, deletions: 2 },
      },
    ])
  })
  it("preserves metadata and linked activity through issue validation", () => {
    const link = {
      title: "Fix invites",
      url: "https://github.com/acme/web/pull/12",
      pullRequest: {
        status: "merged",
        author: { name: "Matthieu" },
        files: 3,
        additions: 24,
        deletions: 2,
      },
    } as const
    const result = issueDraftSchema.parse({
      ...blankIssueDraft(),
      links: [link],
      activity: [
        {
          id: "linked",
          author: "me",
          text: "linked Fix invites",
          createdAt: "2026-10-27T12:00:00.000Z",
          link,
        },
      ],
    })
    expect(result.links[0]).toEqual(link)
    expect(result.activity[0].link).toEqual(link)
  })
  it("shows PRs in existing display preferences and persists hiding them", () => {
    expect(
      displaySchema.parse(defaultIssueDisplay()).showPullRequests
    ).not.toBe(false)
    expect(
      displaySchema.parse({ ...defaultIssueDisplay(), showPullRequests: false })
        .showPullRequests
    ).toBe(false)
  })
})
