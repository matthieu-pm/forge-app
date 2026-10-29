import { describe, expect, it } from "vitest"
import {
  BACKUP_RETENTION_DAYS,
  DAY_MS,
  canRecoverDeletion,
  deletionPurgeTargets,
  deletionRecoveryEndsAt,
  evaluateAgeRetention,
  evaluateDeletionProgress,
  retentionDeadline,
  retentionRules,
} from "./data-lifecycle-policy"
import type {
  DeletionProgress,
  RetainedDataClass,
} from "./data-lifecycle-policy"

const requestedAt = new Date("2026-10-29T12:00:00Z")
const atDay = (days: number) => new Date(requestedAt.getTime() + days * DAY_MS)
const freshProgress = (): DeletionProgress => ({
  policyVersion: 1,
  requestedAt,
  revocationRecorded: true,
  purgeStartedAt: null,
  checkpoints: {},
  backupExpiryVerifiedAt: null,
})
function purgedProgress(): DeletionProgress {
  return {
    ...freshProgress(),
    purgeStartedAt: atDay(30),
    checkpoints: Object.fromEntries(
      deletionPurgeTargets.map((target) => [target, atDay(31)])
    ),
  }
}

describe("FOR-23 AC-01 / AT-01: explicit lifetimes for raw and derived data", () => {
  it("expires raw transcripts without implicitly expiring derived call data", () => {
    expect(retentionDeadline("call-transcript", requestedAt)).toEqual(atDay(30))
    for (const days of [7, 30, 90, 365] as const)
      expect(retentionDeadline("call-transcript", requestedAt, days)).toEqual(
        atDay(days)
      )
    for (const dataClass of [
      "call-summary",
      "call-decision",
      "call-action",
      "call-note",
    ] as const) {
      expect(retentionDeadline(dataClass, requestedAt)).toBeNull()
      expect(
        evaluateAgeRetention({
          dataClass,
          anchor: requestedAt,
          now: atDay(400),
        })
      ).toBe("retain-until-deleted")
    }
  })

  it.each([
    ["agent-input-file", 1],
    ["agent-artifact", 30],
    ["agent-conversation", 90],
    ["agent-event", 90],
    ["agent-summary", 90],
    ["pending-upload", 1],
    ["export-file", 1],
    ["failed-export-staging", 1],
    ["command-receipt", 90],
    ["import-manifest", 90],
    ["workflow-history", 90],
    ["operational-log", 30],
    ["security-audit", 365],
    ["deletion-receipt", 365],
    ["server-backup", 35],
  ] satisfies Array<[RetainedDataClass, number]>)(
    "%s expires at its explicit boundary (%s days)",
    (dataClass, days) => {
      expect(retentionDeadline(dataClass, requestedAt)).toEqual(atDay(days))
      expect(
        evaluateAgeRetention({
          dataClass,
          anchor: requestedAt,
          now: new Date(atDay(days).getTime() - 1),
        })
      ).toBe("retain")
      expect(
        evaluateAgeRetention({
          dataClass,
          anchor: requestedAt,
          now: atDay(days),
        })
      ).toBe("expire")
    }
  )

  it("lists a clock rule for every retained data class, including local backups", () => {
    for (const dataClass of Object.keys(
      retentionRules
    ) as Array<RetainedDataClass>) {
      expect(retentionRules[dataClass].anchor.length).toBeGreaterThan(0)
      expect(() => retentionDeadline(dataClass, requestedAt)).not.toThrow()
    }
    expect(retentionDeadline("local-import-backup", requestedAt)).toBeNull()
    expect(retentionDeadline("resource-file", requestedAt)).toBeNull()
    expect(retentionDeadline("migration-alias", requestedAt)).toBeNull()
  })

  it("protects active/ambiguous agent work without renewing the expiry clock", () => {
    const input = {
      dataClass: "agent-event",
      anchor: requestedAt,
      now: atDay(91),
    } as const
    expect(evaluateAgeRetention({ ...input, activeRunNeedsData: true })).toBe(
      "reconciliation-required"
    )
    expect(
      evaluateAgeRetention({ ...input, unsettledCommandNeedsData: true })
    ).toBe("reconciliation-required")
    expect(evaluateAgeRetention(input)).toBe("expire")
    expect(
      evaluateAgeRetention({
        ...input,
        dataClass: "command-receipt",
        unsettledCommandNeedsData: true,
      })
    ).toBe("reconciliation-required")
    expect(
      evaluateAgeRetention({
        ...input,
        dataClass: "export-file",
        activeRunNeedsData: true,
        unsettledCommandNeedsData: true,
      })
    ).toBe("expire")
  })

  it("rejects malformed times and unsupported retention choices", () => {
    expect(() =>
      retentionDeadline("call-transcript", new Date("invalid"))
    ).toThrow()
    expect(() =>
      retentionDeadline("call-transcript", requestedAt, 0 as 7)
    ).toThrow()
    expect(() => retentionDeadline("call-summary", requestedAt, 7)).toThrow()
    expect(() =>
      retentionDeadline("unknown" as RetainedDataClass, requestedAt)
    ).toThrow()
    expect(() =>
      retentionDeadline("server-backup", new Date(8.64e15))
    ).toThrow()
  })

  it("uses elapsed UTC days across daylight-saving changes", () => {
    const start = new Date("2026-10-24T12:00:00+02:00")
    expect(retentionDeadline("export-file", start)?.toISOString()).toBe(
      "2026-10-25T10:00:00.000Z"
    )
  })
})

describe("FOR-23 AC-02 / AT-02: revoke, recover, purge, verify backups", () => {
  it("requires revocation before reporting a recoverable deletion", () => {
    const progress = { ...freshProgress(), revocationRecorded: false }
    expect(evaluateDeletionProgress(progress, requestedAt)).toEqual({
      phase: "revocation-required",
      ordinaryAccessAllowed: false,
    })
    expect(canRecoverDeletion(progress, requestedAt)).toBe(false)
  })

  it("permits recovery only before the 30-day boundary and before purge", () => {
    expect(deletionRecoveryEndsAt(requestedAt)).toEqual(atDay(30))
    const progress = freshProgress()
    expect(canRecoverDeletion(progress, requestedAt)).toBe(true)
    expect(
      canRecoverDeletion(progress, new Date(atDay(30).getTime() - 1))
    ).toBe(true)
    expect(canRecoverDeletion(progress, atDay(30))).toBe(false)
    expect(evaluateDeletionProgress(progress, atDay(30)).phase).toBe(
      "purge-required"
    )
    expect(canRecoverDeletion(purgedProgress(), atDay(31))).toBe(false)
  })

  it("retains failed byte deletion checkpoints across idempotent retries", () => {
    const progress = purgedProgress()
    delete progress.checkpoints["object-bytes-and-versions"]
    const original = JSON.stringify(progress)
    for (let retry = 0; retry < 2; retry++) {
      expect(evaluateDeletionProgress(progress, atDay(32))).toEqual({
        phase: "purging",
        ordinaryAccessAllowed: false,
      })
      expect(JSON.stringify(progress)).toBe(original)
    }
    progress.checkpoints["object-bytes-and-versions"] = atDay(33)
    expect(evaluateDeletionProgress(progress, atDay(33))).toEqual({
      phase: "awaiting-backup-expiry",
      ordinaryAccessAllowed: false,
      backupExpiresBy: atDay(33 + BACKUP_RETENTION_DAYS),
    })
  })

  it("does not claim completion merely because backup age elapsed", () => {
    const progress = purgedProgress()
    expect(evaluateDeletionProgress(progress, atDay(65)).phase).toBe(
      "awaiting-backup-expiry"
    )
    expect(evaluateDeletionProgress(progress, atDay(66)).phase).toBe(
      "backup-verification-required"
    )
    expect(
      evaluateDeletionProgress(
        { ...progress, backupExpiryVerifiedAt: atDay(66) },
        atDay(66)
      )
    ).toEqual({
      phase: "completed",
      ordinaryAccessAllowed: false,
      backupExpiresBy: atDay(66),
    })
  })

  it.each([
    { policyVersion: 2 },
    { requestedAt: atDay(100) },
    { requestedAt: new Date("invalid") },
    { purgeStartedAt: atDay(29) },
    { purgeStartedAt: atDay(100) },
    { checkpoints: { "database-content": atDay(30) } },
    { backupExpiryVerifiedAt: atDay(40) },
  ] satisfies Array<Partial<DeletionProgress>>)(
    "rejects invalid lifecycle progress: %j",
    (patch) => {
      expect(
        evaluateDeletionProgress({ ...freshProgress(), ...patch }, atDay(40))
          .phase
      ).toBe("invalid-progress")
    }
  )

  it("rejects premature/future backup proof and inconsistent checkpoints", () => {
    for (const backupExpiryVerifiedAt of [
      atDay(65),
      atDay(100),
      new Date("invalid"),
    ])
      expect(
        evaluateDeletionProgress(
          { ...purgedProgress(), backupExpiryVerifiedAt },
          atDay(66)
        ).phase
      ).toBe("invalid-progress")
    for (const completed of [atDay(29), atDay(100), new Date("invalid")])
      expect(
        evaluateDeletionProgress(
          {
            ...purgedProgress(),
            checkpoints: {
              ...purgedProgress().checkpoints,
              "database-content": completed,
            },
          },
          atDay(66)
        ).phase
      ).toBe("invalid-progress")
    expect(
      evaluateDeletionProgress(
        { ...purgedProgress(), revocationRecorded: false },
        atDay(66)
      ).phase
    ).toBe("invalid-progress")
  })

  it("never grants ordinary access while a deletion is pending or completed", () => {
    for (const days of [0, 29, 30, 31, 66, 100]) {
      const progress = days < 31 ? freshProgress() : purgedProgress()
      expect(
        evaluateDeletionProgress(progress, atDay(days)).ordinaryAccessAllowed
      ).toBe(false)
    }
  })
})
