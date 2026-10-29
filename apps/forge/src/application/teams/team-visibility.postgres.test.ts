// @vitest-environment node
import { randomUUID } from "node:crypto"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  assertIsolatedTestConnection,
  verifyIsolatedTestIdentity,
} from "../../../scripts/lib/isolated-test-database"
import type { Actor } from "@/application/actor"
import type * as TeamsModule from "./teams.server"
import type * as MembersModule from "./team-members.server"
import type * as DatabaseModule from "@/db"

const testUrl = process.env.FORGE_TEST_DATABASE_URL

describe.skipIf(!testUrl)("PostgreSQL private-team read boundaries", () => {
  const marker = `team-visibility-${randomUUID()}`
  const workspaceId = `${marker}-workspace`
  const foreignWorkspaceId = `${marker}-foreign`
  const userIds = ["owner", "admin", "member", "outsider"].map(
    (name) => `${marker}-${name}`
  )
  const teamIds = Array.from({ length: 5 }, () => randomUUID())
  let pool: Pool | undefined
  let database: typeof DatabaseModule | undefined
  let teams: typeof TeamsModule
  let members: typeof MembersModule
  let identityVerified = false

  function actor(role = "member", scopes: Actor["scopes"] = null): Actor {
    return {
      workspaceId,
      userId: userIds[role === "owner" ? 0 : role === "admin" ? 1 : 2],
      workspaceRole: role,
      authentication: {
        kind: "session",
        sessionId: `${userIds[role === "owner" ? 0 : role === "admin" ? 1 : 2]}-session`,
      },
      scopes,
    }
  }

  const readerId = (role: string) =>
    userIds[role === "owner" ? 0 : role === "admin" ? 1 : 2]

  beforeAll(async () => {
    const target = assertIsolatedTestConnection(testUrl!)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: testUrl })
    await verifyIsolatedTestIdentity(pool, target)
    identityVerified = true

    vi.stubEnv("DATABASE_URL", testUrl)
    database = await import("@/db")
    teams = await import("./teams.server")
    members = await import("./team-members.server")
    for (const id of [workspaceId, foreignWorkspaceId]) {
      await pool.query(
        "INSERT INTO public.organization(id,name,slug) VALUES ($1,$1,$1)",
        [id]
      )
    }
    // The visibility matrix needs four teams; use paid capacity on these synthetic workspaces.
    for (const id of [workspaceId, foreignWorkspaceId])
      await pool.query(
        "INSERT INTO public.workspace_entitlements(workspace_id,plan,status) VALUES($1,'basic','active')",
        [id]
      )
    for (const id of userIds) {
      await pool.query(
        'INSERT INTO public."user"(id,name,email,email_verified) VALUES($1,$1,$2,true)',
        [id, `${id}@example.test`]
      )
    }
    for (let i = 0; i < 3; i++) {
      await pool.query(
        "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), workspaceId, userIds[i], ["owner", "admin", "member"][i]]
      )
    }
    await pool.query(
      "INSERT INTO public.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [randomUUID(), foreignWorkspaceId, userIds[3]]
    )
    for (let i = 0; i < 3; i++) {
      await pool.query(
        "INSERT INTO session(id,token,user_id,expires_at,active_organization_id) VALUES($1,$1,$2,now()+interval '1 day',$3)",
        [`${userIds[i]}-session`, userIds[i], workspaceId]
      )
      await pool.query(
        "INSERT INTO apikey(id,key,config_id,reference_id,permissions,metadata) VALUES($1,$1,'forge-api',$2,$3,$4)",
        [
          `${userIds[i]}-key`,
          userIds[i],
          JSON.stringify({ teams: ["read"] }),
          JSON.stringify({ workspaceId }),
        ]
      )
    }
    for (let i = 0; i < teamIds.length; i++) {
      await pool.query(
        `INSERT INTO public.teams(id,workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,visibility,created_by_user_id)
        VALUES($1,$2,$3,$4,$3,'icon','fixture','#000000','UTC',$5,$6)`,
        [
          teamIds[i],
          i === 4 ? foreignWorkspaceId : workspaceId,
          [
            "a-private-hidden",
            "b-public",
            "c-private-member",
            "d-public",
            "e-foreign",
          ][i],
          `T${i}`,
          i === 1 || i === 3 ? "workspace" : "private",
          userIds[0],
        ]
      )
    }
    await pool.query(
      "INSERT INTO public.team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
      [workspaceId, teamIds[2], userIds[2]]
    )
  }, 60_000)

  afterAll(async () => {
    try {
      if (pool && identityVerified) {
        await pool.query(
          "DELETE FROM public.organization WHERE id=ANY($1::text[])",
          [[workspaceId, foreignWorkspaceId]]
        )
        await pool.query('DELETE FROM public."user" WHERE id=ANY($1::text[])', [
          userIds,
        ])
      }
    } finally {
      if (database) await database.db.$client.end()
      if (pool) await pool.end()
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it("filters hidden teams before page size and cursors are calculated", async () => {
    const first = await teams.listTeams(actor(), { limit: 1 })
    expect(first.items.map((team) => team.id)).toEqual([teamIds[1]])
    expect(first.nextCursor).toBeTruthy()
    const second = await teams.listTeams(actor(), {
      limit: 1,
      cursor: first.nextCursor!,
    })
    expect(second.items.map((team) => team.id)).toEqual([teamIds[2]])
    const third = await teams.listTeams(actor(), {
      limit: 1,
      cursor: second.nextCursor!,
    })
    expect(third.items.map((team) => team.id)).toEqual([teamIds[3]])
    expect(third.nextCursor).toBeNull()
    expect(JSON.stringify([first, second, third])).not.toContain(
      "a-private-hidden"
    )
  })

  it("returns the same absent result for private nonmember and foreign lookups", async () => {
    expect(await teams.getTeam(actor(), { id: teamIds[0] })).toBeNull()
    expect(
      await teams.getTeam(actor(), { slug: "a-private-hidden" })
    ).toBeNull()
    expect(await teams.getTeam(actor("owner"), { id: teamIds[4] })).toBeNull()
    expect(await teams.getTeam(actor(), { id: teamIds[2] })).toMatchObject({
      id: teamIds[2],
    })
  })

  it.each(["owner", "admin"])(
    "allows %s read-only API keys to read all same-workspace private teams",
    async (role) => {
      const reader: Actor = {
        ...actor(role, ["teams:read"]),
        authentication: {
          kind: "apiKey",
          credentialId: `${readerId(role)}-key`,
        },
      }
      expect(
        (await teams.listTeams(reader)).items.map((team) => team.id)
      ).toEqual(teamIds.slice(0, 4))
      expect(await teams.getTeam(reader, { id: teamIds[0] })).toMatchObject({
        id: teamIds[0],
      })
      expect(
        (await members.getTeamMemberDirectory(reader, "a-private-hidden"))
          .canManage
      ).toBe(false)
      expect(
        (await teams.getTeamDirectory(reader, "active")).items
      ).toHaveLength(4)
    }
  )

  it("uses identical visibility for the web directory, member directory and API list", async () => {
    const directory = await teams.getTeamDirectory(actor(), "active")
    expect(directory.items.map((team) => team.id)).toEqual(teamIds.slice(1, 4))
    await expect(
      members.getTeamMemberDirectory(actor(), "a-private-hidden")
    ).rejects.toThrow("You do not have access")
    expect(
      (
        await members.getTeamMemberDirectory(actor(), "c-private-member")
      ).members.map((member) => member.userId)
    ).toEqual([userIds[2]])
  })

  it("requires teams:read even for workspace owners", async () => {
    const writer = actor("owner", ["teams:write"])
    await expect(teams.listTeams(writer)).rejects.toThrow("cannot read teams")
    await expect(teams.getTeam(writer, { id: teamIds[0] })).rejects.toThrow(
      "cannot read teams"
    )
    await expect(teams.getTeamDirectory(writer, "active")).rejects.toThrow(
      "cannot read teams"
    )
    await expect(
      members.getTeamMemberDirectory(writer, "a-private-hidden")
    ).rejects.toThrow("cannot read teams")
  })
})
