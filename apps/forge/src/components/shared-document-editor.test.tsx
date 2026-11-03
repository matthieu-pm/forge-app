import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { StrictMode } from "react"
import { SharedDocumentEditor } from "./shared-document-editor"
import type * as PreferenceProvider from "@/components/account-preference-provider"
import type {
  DocumentCommandResult,
  SharedDocument,
} from "@/lib/document-contract"
import { loadDocumentHistory } from "@/lib/document-state"
import { defaultDocumentIcon } from "@/lib/team-documents"

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
}))
vi.mock("@/lib/product-storage", () => ({
  productStorageIdentity: () => ({
    workspaceId: "workspace",
    userId: "user",
    sessionId: "session",
  }),
}))
vi.mock("@/components/account-preference-provider", async (original) => ({
  ...(await original<typeof PreferenceProvider>()),
  useWorkspaceView: () => ({
    value: {
      favorite: false,
      collapsedSectionIds: [],
      favoriteResourceIds: [],
    },
    save: () => true,
  }),
}))
vi.mock("@/lib/document-state", () => ({ loadDocumentHistory: vi.fn() }))
vi.mock("./documents/document-content", () => ({
  DocumentContent: ({
    title,
    onTitleChange,
    onBodyChange,
  }: {
    title: string
    onTitleChange: (value: string) => void
    onBodyChange: (value: unknown) => void
  }) => (
    <>
      <input
        aria-label="Document title"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
      />
      <button
        onClick={() =>
          onBodyChange({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Link",
                    marks: [
                      {
                        type: "link",
                        attrs: {
                          href: "https://example.com",
                          target: "_self",
                          class: null,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          })
        }
      >
        Insert safe link
      </button>
    </>
  ),
}))
const resource: SharedDocument = {
  id: "12345678-1234-4234-8234-123456789abc",
  title: "Original",
  body: { type: "doc", content: [{ type: "paragraph" }] },
  icon: defaultDocumentIcon,
  sectionId: null,
  content: "",
  revision: 1,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  owner: { id: "user", name: "Alice" },
  updatedBy: { id: "user", name: "Alice" },
  canDelete: true,
  canShare: false,
  sharedWithWorkspace: false,
}
const saved = (revision: number): DocumentCommandResult => ({
  status: "saved",
  id: resource.id,
  revision,
})
beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)
it("keeps typing made while a save is in flight and sends it against the confirmed revision", async () => {
  let resolve!: (value: DocumentCommandResult) => void
  const command = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    .mockResolvedValue(saved(3))
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.change(await screen.findByLabelText("Document title"), {
    target: { value: "First edit" },
  })
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1), {
    timeout: 3000,
  })
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "Newer typing" },
  })
  await act(async () => {
    resolve(saved(2))
  })
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2), {
    timeout: 3000,
  })
  expect(command.mock.calls[0][0]).toMatchObject({
    expectedRevision: 1,
    fields: { title: "First edit" },
  })
  expect(command.mock.calls[1][0]).toMatchObject({
    expectedRevision: 2,
    fields: { title: "Newer typing" },
  })
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 3")
  )
})
it("retries the exact uncertain command before sending later typing with a fresh key", async () => {
  const command = vi
    .fn()
    .mockRejectedValueOnce(new Error("Network unavailable"))
    .mockResolvedValueOnce(saved(2))
    .mockResolvedValue(saved(3))
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.change(await screen.findByLabelText("Document title"), {
    target: { value: "Uncertain edit" },
  })
  await screen.findByText("Network unavailable", {}, { timeout: 3000 })
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "Later typing" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(command).toHaveBeenCalledTimes(3), {
    timeout: 3000,
  })
  expect(command.mock.calls[1]).toEqual(command.mock.calls[0])
  expect(command.mock.calls[2][0]).toMatchObject({
    expectedRevision: 2,
    fields: { title: "Later typing" },
  })
  expect(command.mock.calls[2][1]).not.toBe(command.mock.calls[0][1])
})
it("normalizes safe link attributes without starting an endless autosave loop", async () => {
  const command = vi.fn().mockResolvedValue(saved(2))
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.click(
    await screen.findByRole("button", { name: "Insert safe link" })
  )
  await waitFor(
    () =>
      expect(screen.getByRole("status").textContent).toBe("Saved · Revision 2"),
    { timeout: 3000 }
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 850))
  })
  expect(command).toHaveBeenCalledTimes(1)
  expect(
    command.mock.calls[0][0].fields.body.content[0].content[0].marks[0].attrs
  ).toEqual({
    href: "https://example.com",
    target: "_blank",
    rel: "noopener noreferrer",
  })
})
it("never executes a different operation smuggled into a device recovery record", async () => {
  const key = JSON.stringify([
    "forge.document-draft",
    1,
    "workspace",
    "user",
    resource.id,
    "old-tab",
  ])
  const raw = JSON.stringify({
    fields: {
      title: resource.title,
      body: resource.body,
      icon: resource.icon,
      sectionId: null,
    },
    baseline: 1,
    attempt: {
      key: crypto.randomUUID(),
      command: { action: "delete", id: resource.id, expectedRevision: 1 },
    },
  })
  localStorage.setItem(key, raw)
  const command = vi.fn()
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  await screen.findByText(
    "Device drafts could not be read. The original copy is preserved."
  )
  expect(command).not.toHaveBeenCalled()
  expect(localStorage.getItem(key)).toBe(raw)
})
it("restores a failed draft after remount and retires its recovery copy only after confirmation", async () => {
  const command = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(saved(2))
  const page = render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.change(await screen.findByLabelText("Document title"), {
    target: { value: "Recover me" },
  })
  await screen.findByText("Offline", {}, { timeout: 3000 })
  expect(localStorage.length).toBe(1)
  page.unmount()
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  await screen.findByText(
    "Unsaved draft recovered. Review it, then retry saving."
  )
  expect(screen.getByLabelText<HTMLInputElement>("Document title").value).toBe(
    "Recover me"
  )
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 2")
  )
  expect(command.mock.calls[1]).toEqual(command.mock.calls[0])
  expect(localStorage.length).toBe(0)
})

it("retains and rebases typing made after dismissing a pending restore", async () => {
  const currentBody = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Bob current body" }],
      },
    ],
  }
  const historicalBody = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Alice historical body" }],
      },
    ],
  }
  vi.mocked(loadDocumentHistory).mockResolvedValueOnce(
    JSON.stringify([
      {
        title: "Historical title",
        body: historicalBody,
        icon: resource.icon,
        sectionId: null,
        revision: 1,
        createdAt: resource.createdAt,
        author: resource.owner,
      },
    ])
  )
  let resolveRestore!: (value: DocumentCommandResult) => void
  const command = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRestore = resolve
        })
    )
    .mockResolvedValue(saved(3))
  render(
    <SharedDocumentEditor
      resource={{ ...resource, body: currentBody }}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.click(await screen.findByRole("button", { name: "History" }))
  fireEvent.click(await screen.findByRole("button", { name: /^Revision 1 ·/ }))
  fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
  expect(command.mock.calls[0][0]).toMatchObject({
    action: "restore",
    expectedRevision: 1,
  })
  fireEvent.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "Typing after dismissing restore" },
  })
  await act(async () => {
    resolveRestore(saved(2))
  })
  expect(screen.getByLabelText<HTMLInputElement>("Document title").value).toBe(
    "Typing after dismissing restore"
  )
  expect(
    JSON.parse(localStorage.getItem(localStorage.key(0)!)!).fields.title
  ).toBe("Typing after dismissing restore")
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2), {
    timeout: 3000,
  })
  expect(command.mock.calls[1][0]).toMatchObject({
    action: "save",
    expectedRevision: 2,
    fields: { title: "Typing after dismissing restore", body: historicalBody },
  })
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 3")
  )
  expect(localStorage.length).toBe(0)
})
it("does not treat a post-restore server refresh as newer local typing", async () => {
  const historical = {
    title: "Historical title",
    body: resource.body,
    icon: resource.icon,
    sectionId: null,
    revision: 1,
    createdAt: resource.createdAt,
    author: resource.owner,
  }
  vi.mocked(loadDocumentHistory).mockResolvedValueOnce(
    JSON.stringify([historical])
  )
  let resolveRestore!: (value: DocumentCommandResult) => void
  const command = vi.fn().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRestore = resolve
      })
  )
  const page = render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.click(await screen.findByRole("button", { name: "History" }))
  fireEvent.click(await screen.findByRole("button", { name: /^Revision 1 ·/ }))
  fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
  fireEvent.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  page.rerender(
    <SharedDocumentEditor
      resource={{ ...resource, title: historical.title, revision: 2 }}
      command={command}
      onBack={() => {}}
    />
  )
  await act(async () => {
    resolveRestore(saved(2))
  })
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 2")
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 850))
  })
  expect(command).toHaveBeenCalledTimes(1)
  expect(localStorage.length).toBe(0)
})

it("recovery is idempotent in StrictMode when the own copy sorts before its source", async () => {
  const sourceKey = JSON.stringify([
    "forge.document-draft",
    1,
    "workspace",
    "user",
    resource.id,
    "source-tab",
  ])
  const record = {
    fields: {
      title: "Recovered writing",
      body: resource.body,
      icon: resource.icon,
      sectionId: null,
    },
    baseline: 1,
  }
  localStorage.setItem(sourceKey, JSON.stringify(record))
  const realKey = Storage.prototype.key,
    realRemove = Storage.prototype.removeItem
  vi.spyOn(Storage.prototype, "key").mockImplementation(function (
    this: Storage,
    index
  ) {
    const keys = Array.from({ length: this.length }, (_, at) =>
      realKey.call(this, at)
    )
    keys.sort((left, right) =>
      left === sourceKey ? 1 : right === sourceKey ? -1 : 0
    )
    return keys[index] ?? null
  })
  const writes = vi.spyOn(Storage.prototype, "setItem")
  vi.spyOn(Storage.prototype, "removeItem")
    .mockImplementationOnce(() => {
      throw new Error("Source cleanup temporarily unavailable")
    })
    .mockImplementation(function (this: Storage, key) {
      realRemove.call(this, key)
    })
  const command = vi.fn().mockResolvedValue(saved(2))
  render(
    <StrictMode>
      <SharedDocumentEditor
        resource={resource}
        command={command}
        onBack={() => {}}
      />
    </StrictMode>
  )
  await screen.findByText(
    "Unsaved draft recovered. Review it, then retry saving."
  )
  expect(writes).toHaveBeenCalledTimes(1)
  expect(localStorage.length).toBe(2)
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 2")
  )
  expect(localStorage.length).toBe(0)
})
it("transfers recovery across multiple reloads without resurrecting stale ancestors", async () => {
  const command = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(saved(2))
  const first = render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.change(await screen.findByLabelText("Document title"), {
    target: { value: "Recovery through two reloads" },
  })
  await screen.findByText("Offline", {}, { timeout: 3000 })
  const firstKey = localStorage.key(0)
  first.unmount()
  const second = render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  await screen.findByText(
    "Unsaved draft recovered. Review it, then retry saving."
  )
  expect(localStorage.length).toBe(1)
  expect(localStorage.key(0)).not.toBe(firstKey)
  const secondKey = localStorage.key(0)
  second.unmount()
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  await screen.findByText(
    "Unsaved draft recovered. Review it, then retry saving."
  )
  expect(localStorage.length).toBe(1)
  expect(localStorage.key(0)).not.toBe(secondKey)
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 2")
  )
  expect(command.mock.calls[1]).toEqual(command.mock.calls[0])
  expect(localStorage.length).toBe(0)
})
it("preserves an ancestor changed by another editor during recovery transfer", async () => {
  const sourceKey = JSON.stringify([
    "forge.document-draft",
    1,
    "workspace",
    "user",
    resource.id,
    "source-tab",
  ])
  const fields = {
    title: "Recovered writing",
    body: resource.body,
    icon: resource.icon,
    sectionId: null,
  }
  localStorage.setItem(sourceKey, JSON.stringify({ fields, baseline: 1 }))
  const changed = JSON.stringify({
    fields: { ...fields, title: "Newer writing in the other tab" },
    baseline: 1,
  })
  const realSet = Storage.prototype.setItem
  let modified = false
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value
  ) {
    realSet.call(this, key, value)
    if (key !== sourceKey && !modified) {
      modified = true
      realSet.call(this, sourceKey, changed)
    }
  })
  const command = vi.fn().mockResolvedValue(saved(2))
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  await screen.findByText(
    "Unsaved draft recovered. Review it, then retry saving."
  )
  expect(localStorage.getItem(sourceKey)).toBe(changed)
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 2")
  )
  expect(localStorage.length).toBe(1)
  expect(localStorage.getItem(sourceKey)).toBe(changed)
})

it("keeps the source recovery record if its durable transfer cannot be written", async () => {
  const sourceKey = JSON.stringify([
    "forge.document-draft",
    1,
    "workspace",
    "user",
    resource.id,
    "source-tab",
  ])
  const raw = JSON.stringify({
    fields: {
      title: "Recovery survives storage failure",
      body: resource.body,
      icon: resource.icon,
      sectionId: null,
    },
    baseline: 1,
  })
  localStorage.setItem(sourceKey, raw)
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded")
  })
  render(
    <SharedDocumentEditor
      resource={resource}
      command={vi.fn()}
      onBack={() => {}}
    />
  )
  await screen.findByText(/Device storage is unavailable. Keep this tab open/)
  expect(screen.getByLabelText<HTMLInputElement>("Document title").value).toBe(
    "Recovery survives storage failure"
  )
  expect(localStorage.getItem(sourceKey)).toBe(raw)
  expect(localStorage.length).toBe(1)
})

it("restores untouched metadata while preserving body edits made during restoration", async () => {
  const currentBody = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Bob current body" }],
      },
    ],
  }
  const historicalBody = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Alice historical body" }],
      },
    ],
  }
  vi.mocked(loadDocumentHistory).mockResolvedValueOnce(
    JSON.stringify([
      {
        title: "Historical title",
        body: historicalBody,
        icon: resource.icon,
        sectionId: null,
        revision: 1,
        createdAt: resource.createdAt,
        author: resource.owner,
      },
    ])
  )
  let resolveRestore!: (value: DocumentCommandResult) => void
  const command = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRestore = resolve
        })
    )
    .mockResolvedValue(saved(3))
  render(
    <SharedDocumentEditor
      resource={{ ...resource, body: currentBody }}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.click(await screen.findByRole("button", { name: "History" }))
  fireEvent.click(await screen.findByRole("button", { name: /^Revision 1 ·/ }))
  fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
  fireEvent.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: "Insert safe link" }))
  await act(async () => {
    resolveRestore(saved(2))
  })
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2), {
    timeout: 3000,
  })
  expect(command.mock.calls[1][0]).toMatchObject({
    action: "save",
    expectedRevision: 2,
    fields: {
      title: "Historical title",
      body: { content: [{ content: [{ text: "Link" }] }] },
    },
  })
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Saved · Revision 3")
  )
})
it("preserves an intentionally returned-to-original field value during restore", async () => {
  vi.mocked(loadDocumentHistory).mockResolvedValueOnce(
    JSON.stringify([
      {
        title: "Historical title",
        body: resource.body,
        icon: resource.icon,
        sectionId: null,
        revision: 1,
        createdAt: resource.createdAt,
        author: resource.owner,
      },
    ])
  )
  let resolveRestore!: (value: DocumentCommandResult) => void
  const command = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRestore = resolve
        })
    )
    .mockResolvedValue(saved(3))
  render(
    <SharedDocumentEditor
      resource={resource}
      command={command}
      onBack={() => {}}
    />
  )
  fireEvent.click(await screen.findByRole("button", { name: "History" }))
  fireEvent.click(await screen.findByRole("button", { name: /^Revision 1 ·/ }))
  fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
  fireEvent.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "Temporary title" },
  })
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: resource.title },
  })
  await act(async () => {
    resolveRestore(saved(2))
  })
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2), {
    timeout: 3000,
  })
  expect(command.mock.calls[1][0]).toMatchObject({
    action: "save",
    expectedRevision: 2,
    fields: { title: resource.title },
  })
})
