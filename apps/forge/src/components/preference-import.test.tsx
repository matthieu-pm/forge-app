import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PreferenceImport, PreferenceImportReview } from "./preference-import"
import type { PreferenceImportManifest } from "@/lib/preference-import-contract"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"
import { invalidatePreferenceSession } from "@/lib/preference-session-events"
import {
  applyPreferenceImportField,
  loadPreferenceImports,
  preparePreferenceImport,
} from "@/lib/preference-import-state"

const mock = vi.hoisted(() => ({
  status: "ready",
  pending: false,
  mode: "enabled",
  refresh: vi.fn(),
}))
vi.mock("@/lib/preference-import-state", () => ({
  loadPreferenceImports: vi.fn(),
  preparePreferenceImport: vi.fn(),
  applyPreferenceImportField: vi.fn(),
}))
vi.mock("./feature-availability", () => ({ useFeatureMode: () => mock.mode }))
vi.mock("./account-preference-provider", () => ({
  useProtectedIdentity: () => ({
    userId: "alice",
    sessionId: "s",
    workspaceId: "w",
  }),
  useAccountPreferences: () => ({
    status: mock.status,
    editable: true,
    pending: mock.pending,
    client: {
      identity: { userId: "alice" },
      getSnapshot: () => ({ pending: mock.pending }),
      refresh: mock.refresh,
    },
  }),
}))
vi.mock("@/lib/product-storage", () => ({
  productStorage: { length: 0, key: () => null, getItem: () => null },
}))
const identity = { userId: "alice", sessionId: "s", workspaceId: "w" }
const source = '{"interfaceTheme":"dark","fontSize":"large","future":true}'
const saved = {
  ...emptyPreferenceSnapshot("alice"),
  revision: 1,
  values: { "general.interfaceTheme": "light" },
  fieldVersions: { "general.interfaceTheme": 1 },
}
async function preview() {
  fireEvent.click(
    screen.getByRole("button", { name: "Preview legacy preferences" })
  )
  await screen.findByText(/Alice \(alice@example.test\)/)
  fireEvent.change(screen.getByLabelText("Preference source"), {
    target: { value: "0" },
  })
}
function confirm() {
  fireEvent.change(screen.getByLabelText("Choice for general.interfaceTheme"), {
    target: { value: "keep" },
  })
  fireEvent.change(screen.getByLabelText("Choice for general.fontSize"), {
    target: { value: "import" },
  })
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and import preferences" })
  )
}
beforeEach(() => {
  mock.status = "ready"
  mock.pending = false
  mock.mode = "enabled"
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem("forge.personal-preferences", source)
  vi.mocked(loadPreferenceImports).mockResolvedValue({
    status: "ready",
    snapshot: saved,
    accountLabel: "Alice (alice@example.test)",
    manifests: [],
  })
  vi.mocked(preparePreferenceImport).mockImplementation(({ data }) =>
    Promise.resolve({
      plan: data,
      fields: {
        "general.interfaceTheme": "kept",
        "general.fontSize": "pending",
      },
    })
  )
  vi.mocked(applyPreferenceImportField).mockImplementation(() =>
    Promise.resolve({
      plan: vi.mocked(preparePreferenceImport).mock.calls[0][0].data,
      fields: { "general.interfaceTheme": "kept", "general.fontSize": "saved" },
    })
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})
describe("FOR-144 explicit preference recovery", () => {
  it("AC-01: does nothing on mount, shows destination/conflicts/exclusions and cancel preserves both sources", async () => {
    render(<PreferenceImportReview identity={identity} />)
    expect(loadPreferenceImports).not.toHaveBeenCalled()
    await preview()
    expect(
      screen.getByText(/General · Interface theme · Conflict/)
    ).toBeTruthy()
    expect(screen.getByText(/general.future: unsupported/)).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Confirm and import preferences" })
        .hasAttribute("disabled")
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Cancel review" }))
    expect(localStorage.getItem("forge.personal-preferences")).toBe(source)
    expect(preparePreferenceImport).not.toHaveBeenCalled()
    expect(applyPreferenceImportField).not.toHaveBeenCalled()
    expect(saved.values["general.interfaceTheme"]).toBe("light")
  })
  it("uploads only after field choices and ownership; successful import retains original bytes", async () => {
    render(<PreferenceImportReview identity={identity} />)
    await preview()
    confirm()
    await screen.findByText("Import finished. Original source retained.")
    expect(preparePreferenceImport).toHaveBeenCalledTimes(1)
    const plan = vi.mocked(preparePreferenceImport).mock.calls[0][0].data
    expect(plan).toMatchObject({
      identity,
      ownershipConfirmed: true,
      source: { raw: source },
      choices: {
        "general.interfaceTheme": "keep",
        "general.fontSize": "import",
      },
    })
    expect(plan.snapshot.values).toEqual({})
    expect(plan.snapshot.fieldVersions).toEqual({})
    expect(applyPreferenceImportField).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("forge.personal-preferences")).toBe(source)
  })
  it("AC-03: changed source is rejected before uploading or patching", async () => {
    render(<PreferenceImportReview identity={identity} />)
    await preview()
    localStorage.setItem(
      "forge.personal-preferences",
      '{"interfaceTheme":"light"}'
    )
    confirm()
    await screen.findByRole("alert")
    expect(screen.getByRole("alert").textContent).toContain("source changed")
    expect(preparePreferenceImport).not.toHaveBeenCalled()
    expect(applyPreferenceImportField).not.toHaveBeenCalled()
    expect(localStorage.getItem("forge.personal-preferences")).toBe(
      '{"interfaceTheme":"light"}'
    )
  })
  it("retries a lost prepare response using the same immutable manifest", async () => {
    vi.mocked(preparePreferenceImport).mockRejectedValueOnce(
      new Error("offline")
    )
    render(<PreferenceImportReview identity={identity} />)
    await preview()
    confirm()
    await screen.findByRole("alert")
    fireEvent.click(
      screen.getByRole("button", { name: "Retry confirmed import" })
    )
    await screen.findByText("Import finished. Original source retained.")
    const calls = vi.mocked(preparePreferenceImport).mock.calls
    expect(calls[0][0].data).toEqual(calls[1][0].data)
  })
  it("AC-02: reload reviews durable checkpoints and resumes remaining fields only", async () => {
    const { preferenceSourceFingerprint } =
      await import("@/lib/preference-import-contract")
    const original = {
      location: "local" as const,
      key: "forge.personal-preferences",
      raw: source,
    }
    const checkpoint: PreferenceImportManifest = {
      plan: {
        id: crypto.randomUUID(),
        identity,
        source: original,
        fingerprint: await preferenceSourceFingerprint(original),
        ownershipConfirmed: true,
        snapshot: saved,
        choices: {
          "general.interfaceTheme": "import",
          "general.fontSize": "import",
        },
      },
      fields: {
        "general.interfaceTheme": "saved",
        "general.fontSize": "pending",
      },
    }
    vi.mocked(loadPreferenceImports).mockResolvedValue({
      status: "ready",
      snapshot: saved,
      accountLabel: "Alice (alice@example.test)",
      manifests: [checkpoint],
    })
    vi.mocked(applyPreferenceImportField).mockResolvedValue({
      ...checkpoint,
      fields: {
        "general.interfaceTheme": "saved",
        "general.fontSize": "conflict",
      },
    })
    render(<PreferenceImportReview identity={identity} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Preview legacy preferences" })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Review checkpoint" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Resume confirmed import" })
    )
    await screen.findByText(/Account values changed after review/)
    expect(preparePreferenceImport).not.toHaveBeenCalled()
    expect(applyPreferenceImportField).toHaveBeenCalledExactlyOnceWith({
      data: {
        identity,
        id: checkpoint.plan.id,
        fingerprint: checkpoint.plan.fingerprint,
        path: "general.fontSize",
      },
    })
  })
  it("account invalidation discards late responses and prevents upload", async () => {
    let finish!: (
      value: Awaited<ReturnType<typeof loadPreferenceImports>>
    ) => void
    vi.mocked(loadPreferenceImports).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<PreferenceImportReview identity={identity} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Preview legacy preferences" })
    )
    act(() => invalidatePreferenceSession("start"))
    await act(() => {
      finish({
        status: "ready",
        snapshot: saved,
        accountLabel: "Old account",
        manifests: [],
      })
      return Promise.resolve()
    })
    expect(screen.queryByText("Old account")).toBeNull()
    expect(preparePreferenceImport).not.toHaveBeenCalled()
  })
  it("hides the importer when account synchronization is disabled", () => {
    mock.status = "disabled"
    const result = render(<PreferenceImport />)
    expect(result.container.textContent).toBe("")
    expect(loadPreferenceImports).not.toHaveBeenCalled()
  })
  it("feature gate removes the importer without starting discovery", () => {
    mock.mode = "disabled"
    const result = render(<PreferenceImport />)
    expect(result.container.textContent).toBe("")
    expect(loadPreferenceImports).not.toHaveBeenCalled()
  })
})
