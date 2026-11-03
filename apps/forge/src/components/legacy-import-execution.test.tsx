import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LegacyImportExecution } from "./legacy-import-execution"
import type { ImportSnapshot } from "@/lib/import-execution-contract"
import {
  loadLegacyImports,
  prepareLegacyImport,
  reconcileLegacyImport,
  resolveLegacyImport,
} from "@/lib/import-execution-state"
import { resumeLegacyImport } from "@/lib/import-execution-client"
import { invalidatePreferenceSession } from "@/lib/preference-session-events"

vi.mock("@/lib/import-execution-state", () => ({
  loadLegacyImports: vi.fn(),
  prepareLegacyImport: vi.fn(),
  resolveLegacyImport: vi.fn(),
  retryLegacyImport: vi.fn(),
  reconcileLegacyImport: vi.fn(),
  downloadLegacyImportReport: vi.fn(),
}))
vi.mock("@/lib/import-execution-client", () => ({
  IMPORT_PROGRESS_CHANGED: "forge:test-import",
  importIdentity: () => ({ workspaceId: "w", sessionId: "s" }),
  resumeLegacyImport: vi.fn(),
}))
vi.mock("@/lib/canonical-issue-cache", () => ({ canonicalIssueEpoch: () => 0 }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const manifest: ImportSnapshot = {
  version: 1,
  policyVersion: 1,
  id: "fdab7d1c-6a0a-4dab-a0dd-ad0cd8d63af3",
  fingerprint: "f".repeat(64),
  workspaceId: "w",
  actorId: "alice",
  revision: 3,
  createdAt: "2026-10-31T10:00:00Z",
  sources: [],
  exclusions: [],
  entries: [
    {
      id: "source-entry",
      sourceKey: "private-source",
      path: "issues/0",
      kind: "issue",
      teamId: "team",
      legacyId: "old",
      fingerprint: "f".repeat(64),
      title: "Private source issue",
      files: [],
      state: "review",
      conflict: {
        fingerprint: "c".repeat(64),
        candidates: [{ id: "target", title: "Shared target", revision: 7 }],
      },
    },
  ],
}
describe("FOR-56 conflict review", () => {
  it("FOR-126 explicitly discovers enabled content from preserved server sources", async () => {
    vi.mocked(loadLegacyImports).mockResolvedValue(JSON.stringify([]))
    vi.mocked(prepareLegacyImport).mockResolvedValue(JSON.stringify(manifest))
    render(<LegacyImportExecution />)
    await screen.findByText("No saved imports for this account and workspace.")
    vi.mocked(loadLegacyImports).mockResolvedValue(JSON.stringify([manifest]))
    fireEvent.click(
      screen.getByRole("button", { name: "Check for preserved content" })
    )
    await screen.findByText("Private source issue · review")
    expect(prepareLegacyImport).toHaveBeenCalledWith({
      data: { workspaceId: "w", sessionId: "s" },
    })
    expect(resumeLegacyImport).not.toHaveBeenCalled()
  })

  it("submits the exact reviewed revision/fingerprint before resuming", async () => {
    vi.mocked(loadLegacyImports).mockResolvedValue(JSON.stringify([manifest]))
    vi.mocked(resolveLegacyImport).mockResolvedValue(JSON.stringify(manifest))
    vi.mocked(resumeLegacyImport).mockResolvedValue(manifest)
    render(<LegacyImportExecution />)
    fireEvent.click(await screen.findByRole("button", { name: "Keep both" }))
    expect(resolveLegacyImport).toHaveBeenCalledWith({
      data: {
        workspaceId: "w",
        sessionId: "s",
        id: manifest.id,
        revision: 3,
        entryId: "source-entry",
        choice: "keep-both",
        conflictFingerprint: "c".repeat(64),
      },
    })
    await vi.waitFor(() => expect(resumeLegacyImport).toHaveBeenCalled())
  })
  it("clears private source content immediately on session invalidation", async () => {
    vi.mocked(loadLegacyImports).mockResolvedValue(JSON.stringify([manifest]))
    render(<LegacyImportExecution />)
    await screen.findByText("Private source issue · review")
    act(() => invalidatePreferenceSession("start"))
    expect(screen.queryByText("Private source issue · review")).toBeNull()
  })
  it("does not render a late private response after invalidation", async () => {
    let resolve!: (value: string) => void
    vi.mocked(loadLegacyImports).mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    render(<LegacyImportExecution />)
    act(() => invalidatePreferenceSession("start"))
    await act(async () => resolve(JSON.stringify([manifest])))
    expect(screen.queryByText("Private source issue · review")).toBeNull()
  })
  it("FOR-57 requires exclusion acknowledgement and sends the exact reconciliation fingerprint", async () => {
    const reconciled: ImportSnapshot = {
      ...manifest,
      entries: [],
      reconciliation: {
        fingerprint: "r".repeat(64),
        checkedAt: "2026-11-01T00:00:00Z",
        ready: true,
        counts: {
          sources: 1,
          records: 1,
          saved: 1,
          skipped: 0,
          unresolved: 0,
          files: 0,
          verifiedFiles: 0,
        },
        discrepancyCount: 0,
        discrepancies: [],
        retainedExclusions: 1,
      },
    }
    vi.mocked(loadLegacyImports).mockResolvedValue(JSON.stringify([reconciled]))
    vi.mocked(reconcileLegacyImport).mockResolvedValue(
      JSON.stringify({
        ...reconciled,
        completedAt: "2026-11-01T00:01:00Z",
        revision: 4,
      })
    )
    render(<LegacyImportExecution />)
    const button = await screen.findByRole("button", {
      name: "Complete reconciled import",
    })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(button)
    await vi.waitFor(() =>
      expect(reconcileLegacyImport).toHaveBeenCalledWith({
        data: {
          workspaceId: "w",
          sessionId: "s",
          id: manifest.id,
          revision: 3,
          action: "complete",
          reportFingerprint: "r".repeat(64),
          acknowledgeExclusions: true,
        },
      })
    )
    await screen.findByText("Import completed · canonical server records")
  })
})
