import { webcrypto } from "node:crypto"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { LegacyImportPreview } from "./legacy-import-preview"
import type { LegacyBackup, PreviewContext } from "@/lib/legacy-import-preview"
import { loadLegacyPreviewContext } from "@/lib/legacy-import-state"
import {
  browserBackupRepository,
  downloadLegacyFile,
} from "@/lib/legacy-import-backup"
import { defaultDefinitionValue } from "@/lib/issue-definition-contract"
import { blankIssueDraft, initialIssueStore } from "@/lib/team-issues"

const saved = vi.hoisted(() => new Map<string, LegacyBackup>())
vi.mock("@/lib/legacy-import-state", () => ({
  loadLegacyPreviewContext: vi.fn(),
}))
vi.mock("@/lib/legacy-import-backup", () => ({
  browserBackupRepository: {
    put: vi.fn((backup: LegacyBackup) => {
      saved.set(backup.id, JSON.parse(JSON.stringify(backup)))
      return Promise.resolve()
    }),
    get: vi.fn((id: string) => Promise.resolve(saved.get(id))),
  },
  downloadLegacyFile: vi.fn(),
  listBrowserBackups: vi.fn((actor: string) =>
    Promise.resolve(
      [...saved.values()].filter((backup) => backup.actorId === actor)
    )
  ),
}))
beforeAll(() => vi.stubGlobal("crypto", webcrypto))
afterAll(() => vi.unstubAllGlobals())
afterEach(cleanup)
const key = "forge:team-issues:v1:old-team"
function context(): PreviewContext {
  return {
    actorId: "alice",
    sessionId: "session",
    workspace: { id: "workspace", name: "My workspace" },
    teams: [{ id: "team", name: "My team", visibility: "private" }],
    definitions: [
      {
        workspaceId: "workspace",
        teamId: "team",
        revision: 0,
        canManage: true,
        value: defaultDefinitionValue(),
      },
    ],
  }
}
beforeEach(() => {
  saved.clear()
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(loadLegacyPreviewContext).mockResolvedValue(context())
  localStorage.setItem(
    key,
    JSON.stringify({
      ...initialIssueStore(),
      issues: [
        {
          ...blankIssueDraft(),
          id: "id",
          number: 1,
          title: "A real legacy issue",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          statusChangedAt: "2026-10-01T00:00:00Z",
          creator: "Original author",
          suggestedLabel: "",
          completedAt: null,
        },
      ],
    })
  )
})
async function preview() {
  fireEvent.click(screen.getByRole("button", { name: "Preview browser data" }))
  await screen.findByText("Destination workspace:")
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Preview again",
      }).disabled
    ).toBe(false)
  )
}
async function selectAndBackUp() {
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Back up this source: Team issues" })
  )
  fireEvent.change(
    screen.getByRole("combobox", { name: "Destination for Team issues" }),
    { target: { value: "team" } }
  )
  fireEvent.click(screen.getByText(/Choose records/))
  fireEvent.click(screen.getByRole("checkbox", { name: "A real legacy issue" }))
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I am entitled to import/ })
  )
  fireEvent.click(screen.getByRole("button", { name: "Save local backup" }))
  await screen.findByText(/Backup saved and verified/)
}

describe("browser data review UI", () => {
  it("does not discover, contact the server or write a backup until explicitly requested", () => {
    render(<LegacyImportPreview />)
    expect(loadLegacyPreviewContext).not.toHaveBeenCalled()
    expect(browserBackupRepository.put).not.toHaveBeenCalled()
    expect(screen.queryByText("A real legacy issue")).toBeNull()
  })
  it("starts unselected and exposes counts, invalid data and destination choices without changing originals", async () => {
    localStorage.setItem(
      'forge:signal-documents:v1:["workspace","alice"]',
      "{broken"
    )
    localStorage.setItem("forge:profile:bob", '{"displayName":"PRIVATE"}')
    const before = { ...localStorage }
    render(<LegacyImportPreview />)
    await preview()
    expect(screen.getByText(/1 other-account sources excluded/)).toBeTruthy()
    expect(screen.queryByText("PRIVATE")).toBeNull()
    expect(screen.getByText(/Version 1.*malformed/)).toBeTruthy()
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: "Destination for Team issues",
      }).value
    ).toBe("")
    expect(
      screen
        .getAllByRole("checkbox")
        .every((input) => !(input as HTMLInputElement).checked)
    ).toBe(true)
    expect({ ...localStorage }).toEqual(before)
  })
  it("saves a verified backup, confirms exact choices, downloads real artifacts and keeps originals", async () => {
    const before = { ...localStorage }
    render(<LegacyImportPreview />)
    await preview()
    await selectAndBackUp()
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm selected choices" })
    )
    await screen.findByText(/Choices confirmed for this snapshot/)
    fireEvent.click(
      screen.getByRole("button", { name: "Download verified backup" })
    )
    await waitFor(() => expect(downloadLegacyFile).toHaveBeenCalled())
    expect(vi.mocked(downloadLegacyFile).mock.calls[0][0]).toMatchObject({
      entries: [{ key, raw: before[key] }],
    })
    expect(screen.queryByRole("button", { name: /^Import$/ })).toBeNull()
    expect({ ...localStorage }).toEqual(before)
  })
  it("invalidates confirmation when selection, destination, or cross-tab source changes", async () => {
    render(<LegacyImportPreview />)
    await preview()
    await selectAndBackUp()
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm selected choices" })
    )
    await screen.findByText(/Choices confirmed for this snapshot/)
    fireEvent.change(
      screen.getByRole("combobox", { name: "Destination for Team issues" }),
      { target: { value: "" } }
    )
    expect(screen.queryByText(/Choices confirmed for this snapshot/)).toBeNull()
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: /I am entitled/,
      }).checked
    ).toBe(false)
    fireEvent(window, new StorageEvent("storage", { key }))
    expect(screen.getByRole("alert").textContent).toContain(
      "Browser data changed"
    )
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Confirm selected choices",
      }).disabled
    ).toBe(true)
  })
  it("blocks an account switch before confirmation/download", async () => {
    render(<LegacyImportPreview />)
    await preview()
    await selectAndBackUp()
    vi.mocked(loadLegacyPreviewContext).mockResolvedValue({
      ...context(),
      actorId: "bob",
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Download verified backup" })
    )
    await screen.findByRole("alert")
    expect(screen.getByRole("alert").textContent).toContain("account")
    expect(downloadLegacyFile).not.toHaveBeenCalled()
    expect(screen.queryByText("A real legacy issue")).toBeNull()
  })
  it("rejects a same-tab edit before confirmation even without a storage event", async () => {
    render(<LegacyImportPreview />)
    await preview()
    await selectAndBackUp()
    localStorage.setItem(key, "{changed")
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm selected choices" })
    )
    expect(
      await screen.findByText("Browser data changed. Preview again.")
    ).toBeTruthy()
    expect(screen.queryByText(/Choices confirmed for this snapshot/)).toBeNull()
    expect(localStorage.getItem(key)).toBe("{changed")
    expect(saved.size).toBe(1)
  })
  it("keeps confirmation disabled when the backup write fails", async () => {
    vi.mocked(browserBackupRepository.put).mockRejectedValueOnce(
      new Error("QuotaExceededError")
    )
    render(<LegacyImportPreview />)
    await preview()
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Back up this source: Team issues" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Save local backup" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("alert").textContent).toContain(
      "QuotaExceededError"
    )
    expect(
      screen.queryByRole("button", { name: "Download verified backup" })
    ).toBeNull()
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Confirm selected choices",
      }).disabled
    ).toBe(true)
    expect(localStorage.getItem(key)).toContain("A real legacy issue")
  })
  it("finds retained backups after remount and cancellation leaves the backup and originals intact", async () => {
    const view = render(<LegacyImportPreview />)
    await preview()
    await selectAndBackUp()
    view.unmount()
    render(<LegacyImportPreview />)
    await preview()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Find saved backups for this account",
      })
    )
    await screen.findByRole("button", { name: /Download backup from/ })
    fireEvent.click(screen.getByRole("button", { name: "Cancel review" }))
    expect(saved.size).toBe(1)
    expect(localStorage.getItem(key)).toContain("A real legacy issue")
    expect(
      within(screen.getByRole("region", { name: "Browser data" })).queryByRole(
        "checkbox"
      )
    ).toBeNull()
  })
})
