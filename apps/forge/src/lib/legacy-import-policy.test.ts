import { describe, expect, it } from "vitest"
import {
  evaluateLegacyImportReview,
  resolveLegacyImportConflict,
} from "./legacy-import-policy"
import type { LegacyConflict, LegacyImportReview } from "./legacy-import-policy"

const selection = {
  policyVersion: 1,
  actorId: "alice",
  destination: { kind: "workspace", workspaceId: "w1", teamId: "t1" },
  sourceFingerprint: "snapshot-1",
  selectionFingerprint: "selected-issues-and-mappings-1",
} as const

function review(patch: Partial<LegacyImportReview> = {}): LegacyImportReview {
  return {
    ...selection,
    sourceStatus: "supported",
    canWriteDestination: true,
    backupVerified: true,
    confirmation: { ...selection, ownershipConfirmed: true },
    ...patch,
  }
}

describe("FOR-22 AC-01 / AT-01: mixed-account browser ownership", () => {
  it("requires a choice for ambiguous records even with write permission", () => {
    expect(
      evaluateLegacyImportReview(review({ confirmation: undefined }))
    ).toBe("review-required")
    expect(
      evaluateLegacyImportReview(
        review({ confirmation: { ...selection, ownershipConfirmed: false } })
      )
    ).toBe("review-required")
    expect(evaluateLegacyImportReview(review())).toBe("ready")
  })

  it("does not transfer Bob's personal records to Alice in a shared browser", () => {
    const own = review({ sourceAccountHint: "alice" })
    const other = review({ sourceAccountHint: "bob" })
    expect([own, other].map(evaluateLegacyImportReview)).toEqual([
      "ready",
      "other-account-excluded",
    ])
    // A matching key hint alone still cannot replace explicit confirmation.
    expect(
      evaluateLegacyImportReview({ ...own, confirmation: undefined })
    ).toBe("review-required")
  })

  it("allows personal import only into the current account", () => {
    expect(
      evaluateLegacyImportReview(
        review({ destination: { kind: "account", userId: "bob" } })
      )
    ).toBe("destination-denied")
    const personal = {
      ...selection,
      destination: { kind: "account", userId: "alice" },
    } as const
    expect(
      evaluateLegacyImportReview({
        ...review(),
        ...personal,
        confirmation: { ...personal, ownershipConfirmed: true },
      })
    ).toBe("ready")
  })

  it.each([
    { policyVersion: 2 },
    { actorId: "bob" },
    { destination: { kind: "workspace", workspaceId: "w2", teamId: "t1" } },
    { destination: { kind: "workspace", workspaceId: "w1", teamId: "t2" } },
    { destination: { kind: "workspace", workspaceId: "w1" } },
    { sourceFingerprint: "changed-source" },
    { selectionFingerprint: "changed-records-or-conflict-choice" },
    { sourceFingerprint: "" },
    { selectionFingerprint: "" },
  ] satisfies Array<Partial<LegacyImportReview>>)(
    "invalidates consent when actor/destination/snapshot/selection changes: %j",
    (patch) => {
      expect(evaluateLegacyImportReview(review(patch))).toBe("review-required")
    }
  )

  it.each(["malformed", "unsupported"] as const)(
    "preserves %s source rather than importing defaults",
    (sourceStatus) => {
      expect(evaluateLegacyImportReview(review({ sourceStatus }))).toBe(
        "preserve-source"
      )
    }
  )

  it("does not accept confirmation of a different policy version", () => {
    expect(
      evaluateLegacyImportReview(
        review({
          confirmation: {
            ...selection,
            policyVersion: 0,
            ownershipConfirmed: true,
          },
        })
      )
    ).toBe("review-required")
  })

  it("requires a verified backup and current permission even on resume", () => {
    expect(evaluateLegacyImportReview(review({ backupVerified: false }))).toBe(
      "backup-required"
    )
    expect(
      evaluateLegacyImportReview(review({ canWriteDestination: false }))
    ).toBe("destination-denied")
    expect(evaluateLegacyImportReview(review({ actorId: " " }))).toBe(
      "destination-denied"
    )
    expect(
      evaluateLegacyImportReview(
        review({ destination: { kind: "workspace", workspaceId: " " } })
      )
    ).toBe("destination-denied")
  })
})

const conflict: LegacyConflict = {
  kind: "content",
  sourceChecksum: "local-version",
  target: { checksum: "server-version", version: "r2" },
}

describe("FOR-22 AC-02 / AT-02: preserve conflicting versions", () => {
  it("requires a choice before any conflicting server write", () => {
    expect(resolveLegacyImportConflict(conflict)).toEqual({
      action: "choice-required",
    })
    expect(
      resolveLegacyImportConflict({
        ...conflict,
        choice: { kind: "keep-both" },
      })
    ).toEqual({ action: "create-copy" })
    expect(
      resolveLegacyImportConflict({
        ...conflict,
        choice: { kind: "keep-server" },
      })
    ).toEqual({ action: "skip" })
    expect(
      resolveLegacyImportConflict({
        ...conflict,
        choice: { kind: "use-local", expectedVersion: "r2" },
      })
    ).toEqual({ action: "review-required" })
  })

  it("does not deduplicate merely because two objects have identical content", () => {
    expect(
      resolveLegacyImportConflict({
        ...conflict,
        sourceChecksum: "server-version",
      })
    ).toEqual({ action: "choice-required" })
  })

  it("skips an exact receipt replay but preserves later local or server edits", () => {
    const imported = {
      ...conflict,
      receipt: {
        sourceChecksum: "local-version",
        targetChecksum: "server-version",
      },
    }
    expect(resolveLegacyImportConflict(imported)).toEqual({
      action: "already-imported",
    })
    expect(
      resolveLegacyImportConflict({ ...imported, sourceChecksum: "local-edit" })
    ).toEqual({ action: "choice-required" })
    expect(
      resolveLegacyImportConflict({
        ...imported,
        target: { checksum: "server-edit", version: "r3" },
      })
    ).toEqual({ action: "choice-required" })
    expect(resolveLegacyImportConflict({ ...imported, target: null })).toEqual({
      action: "choice-required",
    })
  })

  it("creates only a new unmapped record without a conflict", () => {
    expect(resolveLegacyImportConflict({ ...conflict, target: null })).toEqual({
      action: "create",
    })
    expect(
      resolveLegacyImportConflict({ ...conflict, sourceChecksum: "" })
    ).toEqual({ action: "review-required" })
  })

  it("requires an explicit revision-checked preference field replacement", () => {
    const preference: LegacyConflict = { ...conflict, kind: "preference-field" }
    expect(resolveLegacyImportConflict(preference)).toEqual({
      action: "choice-required",
    })
    expect(
      resolveLegacyImportConflict({
        ...preference,
        choice: { kind: "keep-both" },
      })
    ).toEqual({ action: "choice-required" })
    expect(
      resolveLegacyImportConflict({
        ...preference,
        choice: { kind: "use-local", expectedVersion: "r2" },
      })
    ).toEqual({ action: "patch-field", expectedVersion: "r2" })
    for (const target of [
      null,
      { checksum: "concurrent-edit", version: "r3" },
    ]) {
      expect(
        resolveLegacyImportConflict({
          ...preference,
          target,
          choice: { kind: "use-local", expectedVersion: "r2" },
        })
      ).toEqual({ action: "review-required" })
    }
  })

  it("requires an atomic absence check before creating a missing preference", () => {
    expect(
      resolveLegacyImportConflict({
        ...conflict,
        kind: "preference-field",
        target: null,
      })
    ).toEqual({ action: "create-field", expectedAbsent: true })
  })

  it("evaluates without changing either input snapshot", () => {
    const reviewed = review()
    const before = JSON.stringify({ reviewed, conflict })
    evaluateLegacyImportReview(reviewed)
    resolveLegacyImportConflict(conflict)
    expect(JSON.stringify({ reviewed, conflict })).toBe(before)
  })
})
