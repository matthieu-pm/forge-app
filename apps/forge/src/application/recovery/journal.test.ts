// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  recoveryEvent,
  signJournalRecord,
  verifyJournalRecord,
} from "./journal"

describe("FOR-38 independent suppression records", () => {
  const event = {
    id: randomUUID(),
    sequence: 1,
    table: "account",
    key: { id: "fixture" },
    action: "patch" as const,
    patch: { access_token: null },
    storageReference: null,
    at: new Date().toISOString(),
  }
  it("permits only suppression of credential contents", () => {
    expect(recoveryEvent.parse(event).patch).toEqual({ access_token: null })
    expect(() =>
      recoveryEvent.parse({ ...event, patch: { access_token: "raw-token" } })
    ).toThrow()
    expect(() =>
      recoveryEvent.parse({ ...event, patch: { transcript: ["private body"] } })
    ).toThrow()
    expect(() =>
      recoveryEvent.parse({ ...event, patch: { private_body: "not allowed" } })
    ).toThrow()
  })
  it("authenticates record identity, body and source", () => {
    const key = randomBytes(32),
      record = {
        version: 1 as const,
        source: {
          branchId: "br-test",
          host: "test.neon.tech",
          database: "test",
          storeId: "store_test",
        },
        operationId: randomUUID(),
        at: new Date().toISOString(),
        kind: "chunk" as const,
        events: [event],
      }
    const signed = signJournalRecord(record, key)
    expect(verifyJournalRecord(signed, key)).toEqual(record)
    expect(() => verifyJournalRecord({ ...signed, events: [] }, key)).toThrow(
      "SIGNATURE"
    )
    expect(() => verifyJournalRecord(signed, randomBytes(32))).toThrow(
      "SIGNATURE"
    )
  })
})
