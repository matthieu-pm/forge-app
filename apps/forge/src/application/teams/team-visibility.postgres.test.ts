// @vitest-environment node
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { parse } from "dotenv"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
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
      authentication: { kind: "session", sessionId: "fixture" },
      scopes,
    }
  }

  beforeAll(async () => {
    const url = new URL(testUrl!)
    expect(url.hostname).toBe(process.env.FORGE_TEST_DATABASE_HOST)
    expect(url.hostname).not.toContain("-pooler")
    const configured = [
      process.env.DATABASE_URL,
      process.env.DATABASE_URL_UNPOOLED,
    ]
    for (const name of [".env", ".env.local"]) {
      try {
        const values = parse(
          await readFile(new URL(`../../../../../${name}`, import.meta.url))
        )
        configured.push(values.DATABASE_URL, values.DATABASE_URL_UNPOOLED)
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error
      }
    }
    for (const value of configured) {
      if (value)
        expect(url.hostname).not.toBe(
          new URL(value).hostname.replace("-pooler.", ".")
        )
    }
    const branch = process.env.FORGE_TEST_NEON_BRANCH_ID
    expect(branch).toMatch(/^br-/)
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: testUrl })
    const identity = await pool.query(
      "SELECT current_setting('neon.branch_id',true) AS branch"
    )
    expect(identity.rows[0].branch).toBe(branch)
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
        authentication: { kind: "apiKey", credentialId: "fixture-key" },
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
