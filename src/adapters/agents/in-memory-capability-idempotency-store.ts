import type {
  CapabilityIdempotencyStore,
  CapabilityInvocationRecord,
} from "@/application/agents/capability-idempotency-store"

function reservationKey(record: CapabilityInvocationRecord) {
  return [
    record.workspaceId,
    record.userId,
    record.runId,
    record.capabilityId,
    record.capabilityVersion,
    record.idempotencyKey,
  ].join("\u0000")
}

export class InMemoryCapabilityIdempotencyStore implements CapabilityIdempotencyStore {
  readonly records = new Map<string, CapabilityInvocationRecord>()
  readonly #idsByKey = new Map<string, string>()

  async reserve(record: CapabilityInvocationRecord) {
    const key = reservationKey(record)
    const existingId = this.#idsByKey.get(key)
    const existing = existingId ? this.records.get(existingId) : undefined
    if (existing && existing.expiresAt > record.createdAt) {
      return { kind: "existing" as const, record: existing }
    }
    if (existingId) this.records.delete(existingId)
    this.records.set(record.id, record)
    this.#idsByKey.set(key, record.id)
    return { kind: "reserved" as const, record }
  }

  async complete(
    recordId: string,
    result: CapabilityInvocationRecord["result"],
    durationMs: number
  ) {
    const record = this.records.get(recordId)
    if (!record || !result) return null
    const completed = {
      ...record,
      state: "completed" as const,
      result,
      outcome: result.ok ? ("succeeded" as const) : ("failed" as const),
      durationMs,
    }
    this.records.set(recordId, completed)
    return completed
  }

  async release(recordId: string) {
    const record = this.records.get(recordId)
    if (!record) return
    this.records.delete(recordId)
    this.#idsByKey.delete(reservationKey(record))
  }
}
