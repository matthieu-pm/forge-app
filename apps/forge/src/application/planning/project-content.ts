import { randomUUID } from "node:crypto"
import type { Actor } from "@/application/actor"
import type { InitiativeComment, InitiativeProject } from "@/lib/initiatives"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { stableJson } from "@/lib/stable-json"

type Entry = InitiativeComment & {
  health?: "On track" | "At risk" | "Off track"
  comments?: Array<InitiativeComment>
}

/** Client snapshots express intent only. Attribution and history come from the command. */
export function reconcileProjectEntries(
  actor: Actor,
  before: Array<Entry>,
  submitted: Array<Entry>,
  now: string
): Array<Entry> {
  if (new Set(submitted.map((e) => e.id)).size !== submitted.length)
    throw new Error("Duplicate post identity.")
  const canEdit = (e: Entry) =>
    e.authorId === actor.userId || hasWorkspaceRole(actor, ["owner", "admin"])
  for (const old of before)
    if (!submitted.some((e) => e.id === old.id) && !canEdit(old))
      throw new ApplicationAccessError()
  const result = submitted.map((entry) => {
    if (
      entry.attachments.length > 3 ||
      entry.attachments.some((a) => a.data || !a.fileId)
    )
      throw new Error("Use a private upload for project attachments.")
    const old = before.find((e) => e.id === entry.id)
    if (!old) {
      if (entry.reactions.length)
        throw new Error("Publish before adding reactions.")
      return {
        ...entry,
        authorId: actor.userId,
        createdAt: now,
        comments: entry.comments
          ? reconcileProjectEntries(actor, [], entry.comments, now)
          : undefined,
      }
    }
    if (
      (entry.text !== old.text || entry.health !== old.health) &&
      !canEdit(old)
    )
      throw new ApplicationAccessError()
    if (
      stableJson(entry.attachments) !== stableJson(old.attachments) &&
      !canEdit(old)
    )
      throw new ApplicationAccessError()
    if (
      new Set(entry.reactions.map((r) => r.emoji)).size !==
      entry.reactions.length
    )
      throw new Error("Duplicate reaction.")
    for (const emoji of new Set(
      [...old.reactions, ...entry.reactions].map((r) => r.emoji)
    )) {
      const others = (reactions: Entry["reactions"]) =>
        reactions
          .find((r) => r.emoji === emoji)
          ?.userIds.filter((id) => id !== actor.userId)
          .sort() ?? []
      if (
        stableJson(others(old.reactions)) !==
        stableJson(others(entry.reactions))
      )
        throw new ApplicationAccessError()
    }
    return {
      ...entry,
      authorId: old.authorId,
      createdAt: old.createdAt,
      reactions: entry.reactions.map((r) => ({
        ...r,
        userIds: [...new Set(r.userIds)],
      })),
      comments: entry.comments
        ? reconcileProjectEntries(
            actor,
            old.comments ?? [],
            entry.comments,
            now
          )
        : undefined,
    }
  })
  // Editing/reordering a post must not change which authored update is latest.
  return result.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
  )
}

export function projectMilestoneEvents(
  actor: Actor,
  before: InitiativeProject["milestones"],
  after: InitiativeProject["milestones"],
  now: string
) {
  const old = before ?? [],
    next = after ?? []
  assertUniqueMilestones(next)
  return next.flatMap((m) => {
    const previous = old.find((v) => v.id === m.id)
    return stableJson(previous) === stableJson(m)
      ? []
      : [
          {
            id: randomUUID(),
            authorId: actor.userId,
            createdAt: now,
            text: `${previous ? "updated" : "added"} milestone ${m.name}`,
          },
        ]
  })
}

export function assertUniqueMilestones(
  milestones: NonNullable<InitiativeProject["milestones"]>
) {
  if (new Set(milestones.map((m) => m.id)).size !== milestones.length)
    throw new Error("Duplicate milestone identity.")
  const identities = milestones.flatMap((m) => [
    ...new Set([m.id, m.name, ...(m.aliases ?? [])]),
  ])
  if (new Set(identities).size !== identities.length)
    throw new Error(
      "Milestone names and aliases must be unique within the project."
    )
}
