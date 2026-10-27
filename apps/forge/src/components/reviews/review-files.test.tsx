import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ReviewFiles } from "./review-files"
import type { ReviewFile } from "@/lib/review-detail"

const files: Array<ReviewFile> = Array.from({ length: 8 }, (_, i) => ({
  path: `src/components/issues/Component${i}.tsx`,
  category: "Implementation",
  language: "tsx",
  commit: "abc123",
  lines: [
    { kind: "add", content: "new line" },
    { kind: "remove", content: "old line" },
  ],
}))
afterEach(cleanup)

it("previews six files, reveals the rest, and opens the selected full path", () => {
  const onSelectFile = vi.fn()
  render(<ReviewFiles files={files} onSelectFile={onSelectFile} />)
  expect(screen.getByRole("heading", { name: "8 files changed" })).toBeTruthy()
  const group = screen.getByRole("button", { name: /^Implementation/ })
  expect(group.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByRole("button", { name: /Component0.tsx/ })).toBeNull()
  fireEvent.click(group)
  expect(group.getAttribute("aria-expanded")).toBe("true")
  expect(
    screen.getAllByRole("button", { name: /Component\d.tsx/ })
  ).toHaveLength(6)
  expect(
    screen.getByRole("button", { name: /Component0.tsx/ }).getAttribute("title")
  ).toBe(files[0].path)
  fireEvent.click(screen.getByRole("button", { name: "2 more files" }))
  expect(
    screen.getAllByRole("button", { name: /Component\d.tsx/ })
  ).toHaveLength(8)
  fireEvent.click(screen.getByRole("button", { name: /Component7.tsx/ }))
  expect(onSelectFile).toHaveBeenCalledWith(files[7].path)
  fireEvent.click(screen.getByRole("button", { name: "Show fewer files" }))
  expect(screen.queryByRole("button", { name: /Component7.tsx/ })).toBeNull()
  fireEvent.click(group)
  expect(screen.queryByRole("button", { name: /Component0.tsx/ })).toBeNull()
})

it("shows category totals without zero changes and handles a file at the repository root", () => {
  render(
    <ReviewFiles
      files={[
        {
          ...files[0],
          path: "README.md",
          category: "Documentation",
          lines: [{ kind: "add", content: "Notes" }],
        },
      ]}
      onSelectFile={vi.fn()}
    />
  )
  expect(screen.getByRole("heading", { name: "1 file changed" })).toBeTruthy()
  const group = screen.getByRole("button", { name: /^Documentation/ })
  expect(group.textContent).toContain("+1")
  expect(group.textContent).not.toContain("−0")
  expect(screen.queryByRole("button", { name: /Implementation/ })).toBeNull()
  fireEvent.click(group)
  expect(
    screen.getByRole("button", { name: "README.md" }).getAttribute("title")
  ).toBe("README.md")
  expect(screen.queryByRole("button", { name: /more files/ })).toBeNull()
})
