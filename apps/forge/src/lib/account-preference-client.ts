import {
  accountPreferenceCommandSchema,
  decodeAccountPreferences,
  emptyPreferenceSnapshot,
  preferenceSnapshotSchema,
} from "./account-preference-contract"
import { preferenceCacheKey } from "./personal-preference-contract"
import type {
  AccountPreferenceCommand,
  AccountPreferenceGroups,
  PreferenceLoadResult,
  PreferenceSaveResult,
  PreferenceSnapshot,
} from "./account-preference-contract"

export type PreferenceIdentity = {
  userId: string
  sessionId: string
  workspaceId: string
  scope?: "account" | "workspace"
}
export type PreferenceTransport = {
  load: () => Promise<PreferenceLoadResult>
  save: (command: AccountPreferenceCommand) => Promise<PreferenceSaveResult>
}
export type PreferenceClientState = {
  status: "loading" | "ready" | "saving" | "error" | "conflict" | "disabled"
  values: Record<string, unknown>
  groups: AccountPreferenceGroups
  message: string
  conflicts: Array<string>
  pending: boolean
}
export class AccountPreferenceClient {
  private snapshot: PreferenceSnapshot
  private pending: Record<string, unknown> = {}
  private expected: Record<string, number> = {}
  private command: AccountPreferenceCommand | null = null
  private active = true
  private running = false
  private loading = false
  private listeners = new Set<() => void>()
  private state: PreferenceClientState
  private cacheKey: string
  private cacheWritable = true
  private draftKey: string
  constructor(
    readonly identity: PreferenceIdentity,
    private transport: PreferenceTransport,
    private storage?: Pick<Storage, "getItem" | "setItem">
  ) {
    this.snapshot = {
      ...emptyPreferenceSnapshot(identity.userId),
      ...(identity.scope === "workspace"
        ? { workspaceId: identity.workspaceId }
        : {}),
    }
    this.draftKey = `forge:preference-draft:v1:${identity.scope ?? "account"}:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.workspaceId)}`
    this.cacheKey = preferenceCacheKey(
      identity.scope === "workspace"
        ? {
            kind: "workspace",
            userId: identity.userId,
            workspaceId: identity.workspaceId,
          }
        : { kind: "account", userId: identity.userId }
    )
    try {
      const raw = storage?.getItem(this.cacheKey) ?? null
      const cached = preferenceSnapshotSchema.safeParse(
        JSON.parse(raw ?? "null")
      )
      this.cacheWritable =
        raw === null ||
        (cached.success &&
          cached.data.userId === identity.userId &&
          cached.data.workspaceId === this.snapshot.workspaceId)
      if (
        cached.success &&
        cached.data.userId === identity.userId &&
        cached.data.workspaceId === this.snapshot.workspaceId
      )
        this.snapshot = cached.data
    } catch {
      this.cacheWritable = false
      /* A cache is optional and never establishes authentication. */
    }
    this.state = {
      status: "loading",
      values: this.snapshot.values,
      groups: decodeAccountPreferences(this.snapshot.values),
      message: "Loading your preferences…",
      conflicts: [],
      pending: false,
    }
    try {
      const raw = JSON.parse(storage?.getItem(this.draftKey) ?? "null")
      if (
        raw &&
        raw.userId === identity.userId &&
        raw.workspaceId === identity.workspaceId
      ) {
        const command = accountPreferenceCommandSchema.parse({
          ...raw.command,
          sessionId: identity.sessionId,
          expectedWorkspaceId: identity.workspaceId,
        })
        const all = accountPreferenceCommandSchema.parse({
          ...command,
          patch: raw.pending,
          expectedVersions: raw.expected,
        })
        this.command = command
        this.pending = all.patch
        this.expected = all.expectedVersions
        this.publish(
          raw.conflict ? "conflict" : "error",
          "Unsaved preferences recovered from this device. Review and retry when connected."
        )
      }
    } catch {
      /* Preserve unsupported drafts for recovery by a compatible client. */
    }
  }
  private retainDraft() {
    if (!this.active) return
    try {
      if (Object.keys(this.pending).length)
        this.command ??= {
          sessionId: this.identity.sessionId,
          expectedWorkspaceId: this.identity.workspaceId,
          ...(this.identity.scope === "workspace"
            ? { scope: "workspace" as const }
            : {}),
          commandKey: crypto.randomUUID(),
          version: 1,
          patch: { ...this.pending },
          expectedVersions: { ...this.expected },
        }
      this.storage?.setItem(
        this.draftKey,
        JSON.stringify(
          Object.keys(this.pending).length
            ? {
                userId: this.identity.userId,
                workspaceId: this.identity.workspaceId,
                pending: this.pending,
                expected: this.expected,
                command: this.command,
                conflict: this.state.status === "conflict",
              }
            : null
        )
      )
    } catch {
      /* The product storage layer reports device failures globally. */
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.state
  private publish(
    status: PreferenceClientState["status"],
    message: string,
    conflicts: Array<string> = []
  ) {
    if (!this.active) return
    this.state = {
      status,
      message,
      conflicts,
      pending: Object.keys(this.pending).length > 0,
      values: { ...this.snapshot.values, ...this.pending },
      groups: decodeAccountPreferences({
        ...this.snapshot.values,
        ...this.pending,
      }),
    }
    for (const listener of this.listeners) listener()
  }
  private accept(raw: PreferenceSnapshot) {
    const next = preferenceSnapshotSchema.parse(raw)
    if (
      next.userId !== this.identity.userId ||
      next.workspaceId !== this.snapshot.workspaceId
    )
      throw new Error("Preference session changed.")
    if (next.revision < this.snapshot.revision)
      throw new Error("Outdated preference response.")
    this.snapshot = next
    try {
      if (this.cacheWritable)
        this.storage?.setItem(this.cacheKey, JSON.stringify(next))
    } catch {
      /* Server save succeeded even when local cache is unavailable. */
    }
  }
  async refresh() {
    if (!this.active || this.running || this.loading || this.state.pending)
      return
    this.loading = true
    try {
      const result = await this.transport.load()
      if (!this.active) return
      if (result.status === "disabled") {
        this.publish(
          "disabled",
          "Account preference sync is not available yet."
        )
        return
      }
      this.accept(result.snapshot)
      this.publish("ready", "Preferences saved to your account")
    } catch {
      this.publish(
        "error",
        "Your preferences could not be loaded. Retry when connected."
      )
    } finally {
      this.loading = false
    }
  }
  edit(patch: Record<string, unknown>) {
    if (!this.active || !["ready", "saving"].includes(this.state.status))
      throw new Error("Load or retry your preferences before editing.")
    const expectedVersions = Object.fromEntries(
      Object.keys(patch).map((key) => [
        key,
        this.snapshot.fieldVersions[key] ?? 0,
      ])
    )
    const validated = accountPreferenceCommandSchema.parse({
      sessionId: this.identity.sessionId,
      expectedWorkspaceId: this.identity.workspaceId,
      ...(this.identity.scope === "workspace"
        ? { scope: "workspace" as const }
        : {}),
      commandKey: crypto.randomUUID(),
      version: 1,
      patch,
      expectedVersions,
    })
    for (const [key, value] of Object.entries(validated.patch)) {
      if (!Object.hasOwn(this.pending, key))
        this.expected[key] = this.snapshot.fieldVersions[key] ?? 0
      this.pending[key] = structuredClone(value)
    }
    this.publish("saving", "Saving preferences…")
    this.retainDraft()
    void this.flush()
  }
  private async flush() {
    if (!this.active || this.running || !Object.keys(this.pending).length)
      return
    this.running = true
    this.command ??= {
      sessionId: this.identity.sessionId,
      expectedWorkspaceId: this.identity.workspaceId,
      ...(this.identity.scope === "workspace"
        ? { scope: "workspace" as const }
        : {}),
      commandKey: crypto.randomUUID(),
      version: 1,
      patch: { ...this.pending },
      expectedVersions: { ...this.expected },
    }
    const command = this.command
    this.retainDraft()
    try {
      const result = await this.transport.save(command)
      if (!this.active) return
      this.accept(result.snapshot)
      if (result.status === "conflict") {
        this.command = null
        this.publish(
          "conflict",
          "Some preferences changed in another session. Review the saved values before editing again.",
          result.fields
        )
        return
      }
      // A replay may read newer state. Never silently rebase an edit over someone else's change.
      const conflicts: Array<string> = []
      for (const [key, value] of Object.entries(command.patch)) {
        if (JSON.stringify(this.pending[key]) === JSON.stringify(value)) {
          delete this.pending[key]
          delete this.expected[key]
        } else if (
          JSON.stringify(this.snapshot.values[key]) === JSON.stringify(value)
        )
          this.expected[key] = this.snapshot.fieldVersions[key] ?? 0
        else conflicts.push(key)
      }
      this.command = null
      if (conflicts.length) {
        this.publish(
          "conflict",
          "A preference changed in another session. Review the saved values before editing again.",
          conflicts
        )
        return
      }
      this.publish(
        Object.keys(this.pending).length ? "saving" : "ready",
        Object.keys(this.pending).length
          ? "Saving preferences…"
          : "Preferences saved to your account"
      )
    } catch {
      this.publish(
        "error",
        "Changes are not saved. Reconnect and retry; your changes are still here."
      )
    } finally {
      this.running = false
      this.retainDraft()
    }
    if (this.active && this.state.status === "saving") void this.flush()
  }
  retry = async () => {
    if (!this.active || this.state.status === "conflict") return
    if (this.state.pending) {
      this.publish("saving", "Retrying preference save…")
      await this.flush()
    } else await this.refresh()
  }
  reviewSaved = async () => {
    if (!this.active || this.running) return
    this.pending = {}
    this.expected = {}
    this.command = null
    this.retainDraft()
    this.publish("loading", "Loading saved preferences…")
    await this.refresh()
  }
  activate() {
    this.active = true
  }
  dispose() {
    this.active = false
    this.pending = {}
    this.expected = {}
    this.command = null
    this.listeners.clear()
  }
}
