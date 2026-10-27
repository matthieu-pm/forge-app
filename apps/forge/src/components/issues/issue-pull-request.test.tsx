import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  IssueDiffs,
  IssuePullRequestLink,
  LinkPullRequestDialog,
} from "./issue-pull-request"
import { issuePullRequest } from "@/lib/issue-pull-requests"

const request = issuePullRequest({
  title: "Fix permissions",
  url: "https://gitlab.com/acme/web/-/merge_requests/1",
  pullRequest: {
    status: "merged",
    author: { name: "Matthieu" },
    files: 3,
    additions: 24,
    deletions: 2,
  },
})!
afterEach(cleanup)
describe("issue PR links", () => {
  it("renders no Diffs section for unlinked issues", () => {
    const { container } = render(<IssueDiffs requests={[]} />)
    expect(container.textContent).toBe("")
  })
  it("renders the linked title in Diffs with the original provider destination", () => {
    render(<IssueDiffs requests={[request]} />)
    expect(screen.getByRole("region", { name: "Diffs" })).toBeTruthy()
    expect(
      screen
        .getByRole("link", { name: /Open linked pull request/ })
        .getAttribute("href")
    ).toBe(request.url)
    expect(screen.getByText("Fix permissions")).toBeTruthy()
  })
  it("previews actual metadata and does not activate the parent issue row", async () => {
    const onOpen = vi.fn()
    render(
      <div onClick={onOpen}>
        <IssuePullRequestLink request={request} />
      </div>
    )
    const link = screen.getByRole("link", { name: /Open linked pull request/ })
    fireEvent.focus(link)
    expect(
      await screen.findByRole("dialog", { name: /Pull request preview/ })
    ).toBeTruthy()
    expect(screen.getByText("merged")).toBeTruthy()
    expect(screen.getByText(/3 files/)).toBeTruthy()
    expect(screen.getByText("+24")).toBeTruthy()
    expect(screen.getByText("-2")).toBeTruthy()
    link.addEventListener("click", (event) => event.preventDefault())
    fireEvent.click(link)
    expect(onOpen).not.toHaveBeenCalled()
  })
  it("validates and submits links through the detail dialog", () => {
    const onLink = vi.fn(() => true)
    const onOpenChange = vi.fn()
    render(
      <LinkPullRequestDialog open onOpenChange={onOpenChange} onLink={onLink} />
    )
    fireEvent.change(screen.getByLabelText("Pull request URL"), {
      target: { value: "https://example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Link pull request" }))
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(onLink).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Pull request URL"), {
      target: { value: request.url },
    })
    fireEvent.change(screen.getByLabelText("Title (optional)"), {
      target: { value: request.title },
    })
    fireEvent.click(screen.getByRole("button", { name: "Link pull request" }))
    expect(onLink).toHaveBeenCalledWith({
      title: request.title,
      url: request.url,
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

it("does not invent status or change counts when a URL is all that is known", async () => {
  render(
    <IssuePullRequestLink
      request={issuePullRequest({
        title: "Fix invites",
        url: "https://github.com/acme/web/pull/2",
      })!}
    />
  )
  fireEvent.focus(
    screen.getByRole("link", { name: /Open linked pull request/ })
  )
  const preview = await screen.findByRole("dialog", {
    name: /Pull request preview/,
  })
  expect(preview.textContent).toBe("Fix invitesweb#2")
})
it("lets the user unlink a PR from Diffs", () => {
  const onUnlink = vi.fn()
  render(<IssueDiffs requests={[request]} onUnlink={onUnlink} />)
  fireEvent.click(
    screen.getByRole("button", { name: "Unlink pull request #1" })
  )
  expect(onUnlink).toHaveBeenCalledWith(request)
})
