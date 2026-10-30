import { render, renderHook } from "@testing-library/react"
import type {
  WorkspaceViewKind,
  WorkspaceViewValues,
} from "@/lib/workspace-preference-contract"
import type { ReactElement, ReactNode } from "react"
import type {
  AccountPreferenceCommand,
  PreferenceSaveResult,
  PreferenceSnapshot,
} from "@/lib/account-preference-contract"
import {
  decodeWorkspaceView,
  workspaceViewPrefix,
} from "@/lib/workspace-preference-contract"
import { AccountPreferenceScope } from "@/components/account-preference-provider"
import { AccountPreferenceClient } from "@/lib/account-preference-client"
import {
  decodeAccountPreferences,
  emptyPreferenceSnapshot,
  flattenPreferences,
  preferenceSnapshotSchema,
} from "@/lib/account-preference-contract"

type Entry = {
  snapshot: PreferenceSnapshot
  client: AccountPreferenceClient
  offline: boolean
}
const accounts = new Map<string, Entry>(),
  workspaces = new Map<string, Entry>()
let defaultUser = "alice",
  defaultWorkspace = "workspace"
const key = (userId: string, workspaceId: string) =>
  JSON.stringify([userId, workspaceId])
async function create(
  userId: string,
  workspaceId: string,
  scope: "account" | "workspace"
) {
  const entry: Entry = {
    snapshot: {
      ...emptyPreferenceSnapshot(userId),
      ...(scope === "workspace" ? { workspaceId } : {}),
    },
    client: null as unknown as AccountPreferenceClient,
    offline: false,
  }
  entry.client = new AccountPreferenceClient(
    { userId, sessionId: `session-${userId}`, workspaceId, scope },
    {
      load: () =>
        Promise.resolve({
          status: "ready",
          snapshot: structuredClone(entry.snapshot),
        }),
      save: (
        command: AccountPreferenceCommand
      ): Promise<PreferenceSaveResult> => {
        if (entry.offline) return Promise.reject(new Error("offline"))
        const fields = Object.keys(command.patch).filter(
          (field) =>
            (entry.snapshot.fieldVersions[field] ?? 0) !==
            command.expectedVersions[field]
        )
        if (fields.length)
          return Promise.resolve({
            status: "conflict",
            fields,
            snapshot: structuredClone(entry.snapshot),
          })
        const revision = entry.snapshot.revision + 1
        entry.snapshot = preferenceSnapshotSchema.parse({
          ...entry.snapshot,
          revision,
          values: { ...entry.snapshot.values, ...command.patch },
          fieldVersions: {
            ...entry.snapshot.fieldVersions,
            ...Object.fromEntries(
              Object.keys(command.patch).map((field) => [field, revision])
            ),
          },
        })
        return Promise.resolve({
          status: "saved",
          snapshot: structuredClone(entry.snapshot),
        })
      },
    }
  )
  await entry.client.refresh()
  return entry
}
export async function setupPreferenceFixture(
  userId = "alice",
  workspaceId = "workspace"
) {
  for (const entry of [...accounts.values(), ...workspaces.values()])
    entry.client.dispose()
  accounts.clear()
  workspaces.clear()
  defaultUser = userId
  defaultWorkspace = workspaceId
  for (const user of new Set([
    userId,
    "alice",
    "bob",
    "a",
    "test",
    "user",
    "other",
    "u",
    "me",
    "someone-else",
    "another",
  ])) {
    accounts.set(user, await create(user, workspaceId, "account"))
    for (const workspace of new Set([
      workspaceId,
      "workspace",
      "workspace-a",
      "workspace-b",
      "ws",
      "w1",
      "w2",
      "workspace-1",
    ]))
      workspaces.set(
        key(user, workspace),
        await create(user, workspace, "workspace")
      )
  }
}
export function PreferenceFixtureScope({
  children,
  userId = defaultUser,
  workspaceId = defaultWorkspace,
}: {
  children: ReactNode
  userId?: string
  workspaceId?: string
}) {
  return (
    <AccountPreferenceScope
      client={accounts.get(userId)!.client}
      workspaceClient={workspaces.get(key(userId, workspaceId))!.client}
    >
      {children}
    </AccountPreferenceScope>
  )
}
export function renderPreferences(element: ReactElement) {
  const props = element.props as {
    userId?: string
    user?: { id: string }
    scope?: { userId: string; workspaceId: string }
    workspaceId?: string
    workspace?: { id: string }
  }
  return render(
    <PreferenceFixtureScope
      userId={
        props.userId ?? props.user?.id ?? props.scope?.userId ?? defaultUser
      }
      workspaceId={
        props.workspaceId ??
        props.workspace?.id ??
        props.scope?.workspaceId ??
        defaultWorkspace
      }
    >
      {element}
    </PreferenceFixtureScope>
  )
}
export function renderPreferenceHook<TResult>(callback: () => TResult) {
  return renderHook(callback, { wrapper: PreferenceFixtureScope })
}
export function readTestPreferences(userId: string) {
  return accounts.get(userId)!.client.getSnapshot().groups
}
export function readTestWorkspacePreferences(
  userId = defaultUser,
  workspaceId = defaultWorkspace
) {
  return workspaces.get(key(userId, workspaceId))!.client.getSnapshot().values
}
export function savedTestPreferences(userId: string) {
  return decodeAccountPreferences(accounts.get(userId)!.snapshot.values)
}
export function failPreferenceSaves(userId: string, value = true) {
  accounts.get(userId)!.offline = value
}
export async function externalPreferenceEdit(
  userId: string,
  patch: Record<string, unknown>
) {
  const entry = accounts.get(userId)!,
    revision = entry.snapshot.revision + 1
  entry.snapshot = preferenceSnapshotSchema.parse({
    ...entry.snapshot,
    revision,
    values: { ...entry.snapshot.values, ...patch },
    fieldVersions: {
      ...entry.snapshot.fieldVersions,
      ...Object.fromEntries(
        Object.keys(patch).map((field) => [field, revision])
      ),
    },
  })
  await entry.client.refresh()
}
export function readTestView<TKind extends WorkspaceViewKind>(
  kind: TKind,
  resource = "main",
  userId = defaultUser,
  workspaceId = defaultWorkspace
) {
  return decodeWorkspaceView(
    kind,
    resource,
    readTestWorkspacePreferences(userId, workspaceId)
  )
}
export function seedTestView<TKind extends WorkspaceViewKind>(
  kind: TKind,
  resource: string,
  patch: Partial<WorkspaceViewValues<TKind>>,
  userId = defaultUser,
  workspaceId = defaultWorkspace
) {
  const entry = workspaces.get(key(userId, workspaceId))!,
    value = { ...readTestView(kind, resource, userId, workspaceId), ...patch }
  entry.client.edit(
    flattenPreferences(value, workspaceViewPrefix(kind, resource))
  )
}
