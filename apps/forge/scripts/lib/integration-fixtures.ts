import { createHash } from "node:crypto"
import { verifyIsolatedTestIdentity } from "./isolated-test-database"
import type { IsolatedClient } from "./isolated-test-database"

/** The only input is an invocation UUID, never caller-supplied row IDs or SQL prefixes. */
export function integrationFixtureIds(runId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      runId
    )
  )
    throw new Error("A lowercase random UUID v4 fixture run ID is required.")
  return ["a", "b"].map((label) => {
    const workspaceId = `for27-${runId}-${label}`
    const hash = createHash("sha256").update(workspaceId).digest("hex")
    return {
      workspaceId,
      userId: `${workspaceId}-owner`,
      memberId: `${workspaceId}-member`,
      email: `${workspaceId}@example.test`,
      teamId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      name: `Integration fixture ${label.toUpperCase()}`,
    }
  })
}

/** One connected session. Verify SQL identity before BEGIN, locks, inserts or deletes. */
export async function manageIntegrationFixtures(
  client: IsolatedClient,
  action: string,
  runId: string
) {
  if (action !== "seed" && action !== "cleanup")
    throw new Error("Use seed or cleanup.")
  const fixtures = integrationFixtureIds(runId)
  await verifyIsolatedTestIdentity(client)
  await client.query("BEGIN")
  try {
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '30s'")
    // Serialize replay/cleanup of this invocation without blocking independent fixture runs.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,27))",
      [runId]
    )
    for (const fixture of fixtures) {
      const { workspaceId, userId, memberId, email, teamId, name } = fixture
      // An exact-ID collision or edited identity is an error, never permission to adopt/delete it.
      const existing = await client.query(
        `SELECT
        EXISTS(SELECT 1 FROM public.organization WHERE id=$1 AND (slug<>$1 OR name<>$4)) OR
        EXISTS(SELECT 1 FROM public."user" WHERE id=$2 AND (email<>$3 OR name<>$4)) OR
        EXISTS(SELECT 1 FROM public.member WHERE user_id=$2 AND organization_id<>$1) OR
        EXISTS(SELECT 1 FROM public.member WHERE id=$5 AND (organization_id<>$1 OR user_id<>$2)) OR
        EXISTS(SELECT 1 FROM public.teams WHERE id=$6 AND workspace_id<>$1)
        AS conflict`,
        [workspaceId, userId, email, name, memberId, teamId]
      )
      if (existing.rows[0]?.conflict !== false)
        throw new Error("Fixture ownership verification failed.")
      if (action === "seed") {
        await client.query(
          'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$2,$3,true) ON CONFLICT(id) DO NOTHING',
          [userId, name, email]
        )
        await client.query(
          "INSERT INTO public.organization(id,name,slug) VALUES($1,$2,$1) ON CONFLICT(id) DO NOTHING",
          [workspaceId, name]
        )
        await client.query(
          "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner') ON CONFLICT(id) DO NOTHING",
          [memberId, workspaceId, userId]
        )
        await client.query(
          "INSERT INTO public.teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,visibility,created_by_user_id) VALUES($1,$2,'integration','INT','Integration','icon','fixture','#777777','UTC','workspace',$3) ON CONFLICT(id) DO NOTHING",
          [teamId, workspaceId, userId]
        )
      } else {
        // Workspace FKs remove only descendants of these exact fixture workspace IDs.
        await client.query("DELETE FROM public.organization WHERE id=$1", [
          workspaceId,
        ])
        await client.query('DELETE FROM public."user" WHERE id=$1', [userId])
      }
    }
    await client.query("COMMIT")
    return { version: 1, runId, action, fixtures }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}
