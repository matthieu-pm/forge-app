import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { lockProject } from "./initiatives.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import { projects } from "@/db"
import { readableProjectCondition } from "@/application/resource-policy.server"

/** Caller holds the workspace write fence. Preserve links omitted by authorized projections. */
export async function resolveProjectDependencies(
  tx: Transaction,
  actor: Actor,
  id: string,
  desired: Array<string>,
  previous: Array<string>
) {
  const visible = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, actor.workspaceId),
        readableProjectCondition(actor, projects.id)
      )
    )
  const visibleIds = new Set(visible.map((p) => p.id))
  for (const target of new Set([
    ...desired,
    ...previous.filter((p) => visibleIds.has(p)),
  ])) {
    if (!visibleIds.has(target))
      throw new Error("Choose an accessible dependency project.")
    await lockProject(tx, actor, target)
  }
  const effective = [
    ...new Set([...previous.filter((p) => !visibleIds.has(p)), ...desired]),
  ]
  const rows = await tx
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, actor.workspaceId))
  const graph = new Map(
    rows.map((p) => [p.id, (p.properties.dependencyIds ?? []) as Array<string>])
  )
  graph.set(id, effective)
  const visiting = new Set<string>(),
    visited = new Set<string>()
  function visit(node: string): boolean {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    if ((graph.get(node) ?? []).some(visit)) return true
    visiting.delete(node)
    visited.add(node)
    return false
  }
  if (visit(id))
    throw new Error("These project dependencies would create a cycle.")
  return effective
}
