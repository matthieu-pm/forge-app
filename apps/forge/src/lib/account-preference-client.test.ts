import { describe, expect, it, vi } from "vitest"
import { AccountPreferenceClient } from "./account-preference-client"
import {
  accountPreferenceCommandSchema,
  decodeAccountPreferences,
  emptyPreferenceSnapshot,
  preferenceSnapshotSchema,
} from "./account-preference-contract"
import { preferenceCacheKey } from "./personal-preference-contract"
import type {
  AccountPreferenceCommand,
  PreferenceSnapshot,
} from "./account-preference-contract"
import { productStorage } from "@/lib/product-storage"

function fixture(userId = "alice") {
  let saved = emptyPreferenceSnapshot(userId)
  let offline = false,
    loseResponse = false
  const receipts = new Map<string, string>()
  const save = vi.fn(async (input: AccountPreferenceCommand) => {
    if (offline) throw new Error("offline")
    const hash = JSON.stringify(input)
    if (receipts.has(input.commandKey)) {
      if (receipts.get(input.commandKey) !== hash) throw new Error("reused")
      return { status: "saved" as const, snapshot: structuredClone(saved) }
    }
    const fields = Object.keys(input.patch).filter(
      (key) => (saved.fieldVersions[key] ?? 0) !== input.expectedVersions[key]
    )
    if (fields.length)
      return {
        status: "conflict" as const,
        fields,
        snapshot: structuredClone(saved),
      }
    const revision = saved.revision + 1
    saved = preferenceSnapshotSchema.parse({
      ...saved,
      revision,
      values: { ...saved.values, ...input.patch },
      fieldVersions: {
        ...saved.fieldVersions,
        ...Object.fromEntries(
          Object.keys(input.patch).map((key) => [key, revision])
        ),
      },
    })
    receipts.set(input.commandKey, hash)
    if (loseResponse) {
      loseResponse = false
      throw new Error("response lost")
    }
    return { status: "saved" as const, snapshot: structuredClone(saved) }
  })
  const create = (storage?: Storage) =>
    new AccountPreferenceClient(
      { userId, sessionId: `session-${userId}`, workspaceId: "workspace" },
      {
        load: async () => ({
          status: "ready",
          snapshot: structuredClone(saved),
        }),
        save,
      },
      storage
    )
  return {
    create,
    save,
    saved: () => saved,
    offline: (value: boolean) => {
      offline = value
    },
    loseResponse: () => {
      loseResponse = true
    },
  }
}
async function settled(client: AccountPreferenceClient) {
  await vi.waitFor(() => expect(client.getSnapshot().status).not.toBe("saving"))
}
describe("FOR-127 shared preference client", () => {
  it("AT-01: reloads all personal settings in another owner session, isolated from another account", async () => {
    const owner = fixture(),
      a = owner.create(),
      b = owner.create(),
      other = fixture("bob").create()
    await Promise.all([a.refresh(), b.refresh(), other.refresh()])
    a.edit({
      "general.interfaceTheme": "dark",
      "calls.language": "fr",
      "reviews.startOnToolOpen": false,
      "notifications.updates.marketing": true,
      "agent.guidance": "Private guidance",
    })
    await settled(a)
    await b.refresh()
    expect(b.getSnapshot().groups).toMatchObject({
      general: { interfaceTheme: "dark" },
      calls: { language: "fr" },
      reviews: { startOnToolOpen: false },
      notifications: { updates: { marketing: true } },
      agent: { guidance: "Private guidance" },
    })
    expect(other.getSnapshot().groups.agent.guidance).toBe("")
    const reloaded = owner.create()
    await reloaded.refresh()
    expect(reloaded.getSnapshot().groups).toEqual(b.getSnapshot().groups)
  })
  it("AT-02: preserves independent edits, exposes same-field conflicts and requires explicit review", async () => {
    const owner = fixture(),
      a = owner.create(),
      b = owner.create()
    await Promise.all([a.refresh(), b.refresh()])
    a.edit({ "general.interfaceTheme": "dark" })
    await settled(a)
    b.edit({ "calls.language": "fr" })
    await settled(b)
    expect(owner.saved().values).toMatchObject({
      "general.interfaceTheme": "dark",
      "calls.language": "fr",
    })
    a.edit({ "calls.language": "de" })
    await settled(a)
    expect(a.getSnapshot().status).toBe("conflict")
    expect(owner.saved().values["calls.language"]).toBe("fr")
    await a.retry()
    expect(a.getSnapshot().status).toBe("conflict")
    await a.reviewSaved()
    expect(a.getSnapshot().groups.calls.language).toBe("fr")
  })
  it("AT-03: retries offline and lost responses with the exact key/input, never claims an unsaved change is saved", async () => {
    const owner = fixture(),
      client = owner.create()
    await client.refresh()
    owner.loseResponse()
    client.edit({ "agent.guidance": "Private" })
    await settled(client)
    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      pending: true,
    })
    const first = owner.save.mock.calls[0][0]
    owner.offline(true)
    await client.retry()
    expect(client.getSnapshot().status).toBe("error")
    owner.offline(false)
    await client.retry()
    expect(
      owner.save.mock.calls.every(
        ([input]) => JSON.stringify(input) === JSON.stringify(first)
      )
    ).toBe(true)
    expect(owner.saved().revision).toBe(1)
    expect(client.getSnapshot()).toMatchObject({
      status: "ready",
      pending: false,
    })
  })
  it("coalesces typing while a request is in flight and preserves later edits", async () => {
    const owner = fixture(),
      client = owner.create()
    await client.refresh()
    client.edit({ "agent.guidance": "a" })
    client.edit({ "agent.guidance": "ab" })
    client.edit({ "agent.guidance": "abc", "calls.language": "fr" })
    await settled(client)
    expect(owner.saved().values).toMatchObject({
      "agent.guidance": "abc",
      "calls.language": "fr",
    })
    expect(client.getSnapshot().status).toBe("ready")
  })
  it("discards queued edits and ignores late completions after sign-out/account switch", async () => {
    let resolve!: (value: {
      status: "saved"
      snapshot: PreferenceSnapshot
    }) => void
    const save = vi.fn(
      () =>
        new Promise<{ status: "saved"; snapshot: PreferenceSnapshot }>(
          (done) => {
            resolve = done
          }
        )
    )
    const old = new AccountPreferenceClient(
      { userId: "alice", sessionId: "a", workspaceId: "w" },
      {
        load: async () => ({
          status: "ready",
          snapshot: emptyPreferenceSnapshot("alice"),
        }),
        save,
      },
      productStorage
    )
    await old.refresh()
    old.edit({ "agent.guidance": "private draft" })
    old.dispose()
    resolve({
      status: "saved",
      snapshot: {
        ...emptyPreferenceSnapshot("alice"),
        revision: 1,
        values: { "agent.guidance": "late" },
      },
    })
    await Promise.resolve()
    await old.retry()
    expect(save).toHaveBeenCalledTimes(1)
    const fresh = fixture("bob").create(productStorage)
    await fresh.refresh()
    expect(fresh.getSnapshot().groups.agent.guidance).toBe("")
    expect(
      productStorage.getItem(
        preferenceCacheKey({ kind: "account", userId: "alice" })
      )
    ).not.toContain("late")
  })
  it("validates cache owner/version and does not touch legacy or damaged sources", async () => {
    productStorage.clear()
    productStorage.setItem(
      "forge.personal-preferences",
      '{"interfaceTheme":"dark"}'
    )
    const key = preferenceCacheKey({ kind: "account", userId: "alice" })
    productStorage.setItem(
      key,
      JSON.stringify({
        ...emptyPreferenceSnapshot("bob"),
        values: { "agent.guidance": "bob secret" },
      })
    )
    const client = fixture().create(productStorage)
    expect(client.getSnapshot().groups.agent.guidance).toBe("")
    await client.refresh()
    expect(client.getSnapshot().groups.general.interfaceTheme).toBe("system")
    expect(productStorage.getItem("forge.personal-preferences")).toBe(
      '{"interfaceTheme":"dark"}'
    )
  })
  it("uses valid independent defaults and rejects owner, policy, OS facts, invalid and unversioned patches", () => {
    expect(
      decodeAccountPreferences({
        "calls.language": "fr",
        "general.interfaceTheme": "invalid",
      })
    ).toMatchObject({
      calls: { language: "fr" },
      general: { interfaceTheme: "system" },
    })
    const base = { sessionId: "s", commandKey: crypto.randomUUID(), version: 1 }
    for (const patch of [
      { role: "owner" },
      { userId: "other" },
      { "general.interfaceTheme": "oops" },
      { "device.permission": true },
      { "agent.guidance": 1 },
    ])
      expect(
        accountPreferenceCommandSchema.safeParse({
          ...base,
          patch,
          expectedVersions: Object.fromEntries(
            Object.keys(patch).map((k) => [k, 0])
          ),
        }).success
      ).toBe(false)
    expect(
      accountPreferenceCommandSchema.safeParse({
        ...base,
        patch: { "calls.language": "fr" },
        expectedVersions: {},
      }).success
    ).toBe(false)
  })
  it("server save succeeds when cache storage is unavailable", async () => {
    const owner = fixture()
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
    } as unknown as Storage
    const client = owner.create(store)
    await client.refresh()
    client.edit({ "calls.language": "fr" })
    await settled(client)
    expect(client.getSnapshot().status).toBe("ready")
  })
})

it("FOR-52 restores unsaved preference edits after reload without publishing or crossing accounts", async () => {
  productStorage.clear()
  const f = fixture()
  const old = f.create(productStorage)
  await old.refresh()
  f.save.mockRejectedValueOnce(new Error("Offline"))
  old.edit({ "agent.guidance": "offline preference draft" })
  await vi.waitFor(() => expect(old.getSnapshot().status).toBe("error"))
  const original = f.save.mock.calls[0][0]
  old.dispose()
  const reloaded = f.create(productStorage)
  expect(reloaded.getSnapshot()).toMatchObject({
    status: "error",
    pending: true,
    values: { "agent.guidance": "offline preference draft" },
  })
  expect(f.save).toHaveBeenCalledTimes(1)
  const other = fixture("bob").create(productStorage)
  expect(other.getSnapshot().values["agent.guidance"]).toBeUndefined()
  await reloaded.retry()
  expect(f.save.mock.calls[1][0]).toEqual(original)
})
