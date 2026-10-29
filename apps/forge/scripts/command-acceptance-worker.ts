/** Isolated FOR-32 process fixture. Input/output contains fixture identities only. */
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Pool, neonConfig } from "@neondatabase/serverless"
import {
  assertIsolatedTestConnection,
  verifyIsolatedTestIdentity,
} from "./lib/isolated-test-database"
import type { Actor } from "../src/application/actor"
import type { CreateTeamInput } from "../src/application/teams/team-schemas"

const file = process.env.FORGE_COMMAND_TEST_DATABASE_FILE
if (!file) throw new Error("An explicit isolated command fixture is required.")
const { applicationConnection } = JSON.parse(readFileSync(file, "utf8"))
const target = assertIsolatedTestConnection(applicationConnection)
neonConfig.webSocketConstructor = WebSocket
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const request = JSON.parse((await lines.next()).value ?? "null") as {
  actor: Actor
  input: CreateTeamInput
  key: string
  pause?: boolean
  fault?: "before-mutation" | "after-mutation" | "after-commit"
}
const probe = new Pool({ connectionString: applicationConnection })
await verifyIsolatedTestIdentity(probe, target)
await probe.end()
process.env.DATABASE_URL = applicationConnection
const { databaseClient } = await import("../src/db")
const { executeIdempotent } = await import("../src/api/v1/idempotency.server")
const { createTeam } = await import("../src/application/teams/teams.server")
const { authorizeTeamCreation } =
  await import("../src/application/teams/team-command-authorization.server")
const { teamSummarySchema } =
  await import("../src/application/teams/team-schemas")
try {
  const result = await executeIdempotent({
    actor: request.actor,
    idempotencyKey: request.key,
    operationId: "createTeam",
    input: request.input,
    status: 201,
    parse: (v) => teamSummarySchema.parse(v),
    authorize: authorizeTeamCreation,
    run: async (tx, actor) => {
      if (request.fault === "before-mutation") throw new Error("fixture crash")
      const created = await createTeam(actor, request.input, tx)
      if (!created.ok) throw new Error(created.code)
      if (request.pause) {
        process.stdout.write(JSON.stringify({ phase: "mutated" }) + "\n")
        await lines.next()
      }
      if (request.fault === "after-mutation") throw new Error("fixture crash")
      return {
        value: created.team,
        resource: { type: "team", id: created.team.id },
        events: [
          { topic: "teams.created.v1", payload: { teamId: created.team.id } },
        ],
      }
    },
  })
  if (request.fault === "after-commit") throw new Error("fixture response lost")
  process.stdout.write(JSON.stringify({ phase: "result", ...result }) + "\n")
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      phase: "error",
      reason:
        error instanceof Error && "reason" in error
          ? error.reason
          : "fixture-fault",
    }) + "\n"
  )
  process.exitCode = 2
} finally {
  await databaseClient.end()
  process.stdin.destroy()
}
