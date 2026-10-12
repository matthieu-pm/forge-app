import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { CustomEmojiProvider } from "./custom-emoji-provider"
import { EmojisSettings } from "./emojis-settings"
import { TeamIconPicker } from "./team-icon-picker"
import type { PickerIcon } from "./team-icon-picker"
import type { CustomEmoji, CustomEmojiInput } from "@/lib/custom-emoji-contract"
import { customEmojiValue } from "@/lib/custom-emoji-contract"

vi.mock("@/lib/custom-emoji-state", () => ({
  listCustomEmojis: vi.fn(),
  uploadCustomEmoji: vi.fn(),
  removeCustomEmoji: vi.fn(),
}))
vi.mock("@/lib/custom-emoji-upload", () => ({
  prepareEmojiImage: vi.fn(() =>
    Promise.resolve("data:image/png;base64,iVBORw0KGgoAAA==")
  ),
}))
vi.mock("@hugeicons/core-free-icons?catalog", () => ({ UserGroup03Icon: [] }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const id = "11111111-1111-4111-8111-111111111111"
function sample(input: CustomEmojiInput): CustomEmoji {
  return {
    ...input,
    id,
    value: customEmojiValue(id),
    createdAt: "2026-10-12T17:00:00Z",
    sourceName: "Tester",
    sourceImage: null,
    canRemove: true,
  }
}
function Picker() {
  const [icon, setIcon] = useState<PickerIcon>({
    kind: "emoji",
    value: "🙂",
    color: "#94a3b8",
  })
  return <TeamIconPicker name="Test" value={icon} onChange={setIcon} />
}
beforeAll(() => {
  Element.prototype.scrollTo = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(cleanup)
function setup(initial: Array<CustomEmoji> = []) {
  let rows = initial
  const api = {
    list: vi.fn(() => Promise.resolve(rows)),
    upload: vi.fn((input: CustomEmojiInput) => {
      rows = [...rows, sample(input)]
      return Promise.resolve(rows)
    }),
    remove: vi.fn((target: string) => {
      rows = rows.filter((row) => row.id !== target)
      return Promise.resolve(rows)
    }),
  }
  const view = render(
    <CustomEmojiProvider api={api}>
      <EmojisSettings />
      <Picker />
    </CustomEmojiProvider>
  )
  return { api, view }
}
async function choose() {
  fireEvent.change(screen.getByLabelText("Upload emoji image"), {
    target: {
      files: [new File(["image"], "Release Logo.png", { type: "image/png" })],
    },
  })
  await screen.findByRole("dialog")
}
describe("custom emoji settings and shared picker", () => {
  it("uploads from the empty state, searches and selects the image in the picker, then removes it", async () => {
    const { api } = setup()
    await screen.findByText("No emojis")
    await choose()
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe(
      "release-logo"
    )
    fireEvent.click(screen.getByRole("button", { name: "Upload emoji" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(api.upload).toHaveBeenCalledTimes(1)
    expect(screen.getByText(":release-logo:")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Choose team icon" }))
    fireEvent.change(screen.getByPlaceholderText("Search emoji..."), {
      target: { value: ":release-logo:" },
    })
    fireEvent.click(
      await screen.findByRole("button", { name: ":release-logo:" })
    )
    expect(screen.getByRole("img", { name: ":release-logo:" })).toBeDefined()
    fireEvent.change(screen.getByLabelText("Filter emojis by name"), {
      target: { value: "missing" },
    })
    expect(screen.getByRole("status").textContent).toContain("No emojis match")
    fireEvent.change(screen.getByLabelText("Filter emojis by name"), {
      target: { value: "" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Remove emoji :release-logo:" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove emoji" }))
    await screen.findByText("No emojis")
    expect(api.remove).toHaveBeenCalledWith(id)
    expect(screen.queryByRole("img", { name: ":release-logo:" })).toBeNull()
  })
  it("rejects duplicate names and keeps the dialog open on failed writes", async () => {
    const { api } = setup([
      sample({
        name: "release-logo",
        image: "data:image/png;base64,iVBORw0KGgoAAA==",
      }),
    ])
    await screen.findByText(":release-logo:")
    await choose()
    fireEvent.click(screen.getByRole("button", { name: "Upload emoji" }))
    expect(screen.getByRole("alert").textContent).toContain("already exists")
    expect(api.upload).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "new-logo" },
    })
    api.upload.mockRejectedValueOnce(new Error("Upload failed"))
    fireEvent.click(screen.getByRole("button", { name: "Upload emoji" }))
    expect(await screen.findByText("Upload failed")).toBeDefined()
    expect(screen.getByRole("dialog")).toBeDefined()
  })
  it("does not expose another workspace's emojis after the provider is remounted", async () => {
    const { view } = setup([
      sample({
        name: "private-logo",
        image: "data:image/png;base64,iVBORw0KGgoAAA==",
      }),
    ])
    await screen.findByText(":private-logo:")
    view.unmount()
    setup()
    await screen.findByText("No emojis")
    expect(screen.queryByText(":private-logo:")).toBeNull()
  })
})
