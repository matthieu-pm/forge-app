// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await -- Promise-shaped test doubles intentionally resolve without real I/O. */
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { journalDatabasePool } from "./journaled-pool.server"
import type { Pool } from "@neondatabase/serverless"
import type { DeletionJournalBackend } from "../../application/recovery/journal"

vi.mock("@tanstack/react-start/server-only", () => ({}))

function fixture() {
  const order: Array<string> = []
  let failSql = false,
    failCommit = false,
    failRollback = false,
    commitAsRollback = false
  const query = vi.fn(async (text: string) => {
    order.push(text)
    if (text.includes("current_database"))
      return {
        rows: [
          {
            database: "test",
            branch: "br-test",
            enabled: true,
            missing_capture: 0,
          },
        ],
      }
    if (text.startsWith("SELECT enabled")) return { rows: [{ enabled: true }] }
    if (text.startsWith("SELECT id,sequence")) return { rows: [] }
    if (text === "COMMIT" && failCommit) throw new Error("lost commit response")
    if (text === "ROLLBACK" && failRollback)
      throw new Error("lost rollback response")
    if (text.startsWith("DELETE") && failSql)
      throw new Error("constraint error")
    return {
      rows: [],
      command:
        text === "COMMIT" && commitAsRollback ? "ROLLBACK" : text.split(" ")[0],
    }
  })
  const release = vi.fn()
  const client = { query, release }
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (text: string) => query(text)),
  } as unknown as Pool
  const backend: DeletionJournalBackend = {
    prepare: vi.fn(async () => {
      order.push("R2 prepared")
    }),
    complete: vi.fn(async (_id, _source, events) => {
      for await (const _batch of events) {
      }
      order.push("R2 completed")
    }),
    abort: vi.fn(async () => {
      order.push("R2 aborted")
    }),
  }
  journalDatabasePool(
    pool,
    backend,
    "postgresql://test:secret@test.neon.tech/test?sslmode=require",
    "store_test"
  )
  return {
    pool,
    client,
    release,
    backend,
    order,
    fail: {
      sql: () => {
        failSql = true
      },
      commit: () => {
        failCommit = true
      },
      rollback: () => {
        failRollback = true
      },
      commitAsRollback: () => {
        commitAsRollback = true
      },
    },
  }
}
describe("FOR-38 live deletion SQL boundary", () => {
  it("prepares provider and billing conflict updates before SQL", async () => {
    for (const text of [
      "INSERT INTO call_connections(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET oauth_verifier=$2",
      "INSERT INTO workspace_entitlements(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO UPDATE SET status=$2",
    ]) {
      const f = fixture()
      await f.pool.query(text, [randomUUID(), "test"])
      expect(f.order.indexOf("R2 prepared")).toBeGreaterThan(-1)
      expect(f.order.indexOf("R2 prepared")).toBeLessThan(f.order.indexOf(text))
      expect(f.backend.complete).toHaveBeenCalledOnce()
    }
  })
  it("waits for commit and independent publication before invoking a mutation callback", async () => {
    const f = fixture()
    await new Promise<void>((resolve, reject) => {
      f.pool.query("DELETE FROM session", (error: Error | null) => {
        if (error) {
          reject(error)
          return
        }
        try {
          expect(f.order).toContain("COMMIT")
          expect(f.order).toContain("R2 completed")
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
  })
  it.each([undefined, false] as const)(
    "destroys an uncertain explicit connection on release(%s)",
    async (argument) => {
      const f = fixture(),
        client = await f.pool.connect()
      await client.query("BEGIN")
      await client.query("DELETE FROM session")
      f.fail.commit()
      await expect(client.query("COMMIT")).rejects.toThrow("lost commit")
      client.release(argument)
      expect(f.release).toHaveBeenCalledWith(expect.any(Error))
      expect(f.backend.abort).not.toHaveBeenCalled()
    }
  )
  it("returns publication failure through a mutation callback", async () => {
    const f = fixture()
    vi.mocked(f.backend.complete).mockRejectedValue(new Error("R2 unavailable"))
    await new Promise<void>((resolve, reject) => {
      f.pool.query("DELETE FROM session", (error: Error | null) => {
        try {
          expect(error?.message).toContain("PUBLICATION_PENDING")
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    })
  })
  it("prepares first policy inserts, leaving ordinary insert-do-nothing on the fast path", async () => {
    const f = fixture()
    await f.pool.query(
      'INSERT INTO "public"."call_settings" (workspace_id,retention_days) VALUES ($1,$2)',
      ["workspace", 7]
    )
    expect(f.backend.prepare).toHaveBeenCalledOnce()
    const other = fixture()
    await other.pool.query(
      "INSERT INTO session(id) VALUES($1) ON CONFLICT DO NOTHING",
      ["session"]
    )
    expect(other.backend.prepare).not.toHaveBeenCalled()
  })
  it("prepares outside the DB before deletion, commits SQL, then completes before acknowledgement", async () => {
    const f = fixture()
    await f.pool.query("DELETE FROM session WHERE id=$1", [randomUUID()])
    expect(f.order.indexOf("R2 prepared")).toBeLessThan(
      f.order.indexOf("DELETE FROM session WHERE id=$1")
    )
    expect(f.order.indexOf("COMMIT")).toBeLessThan(
      f.order.indexOf("R2 completed")
    )
    expect(f.release).toHaveBeenCalledOnce()
  })
  it("does not mutate the DB if independent preparation fails", async () => {
    const f = fixture()
    vi.mocked(f.backend.prepare).mockRejectedValue(new Error("R2 unavailable"))
    await expect(f.pool.query("DELETE FROM session")).rejects.toThrow()
    expect(f.order).not.toContain("DELETE FROM session")
    expect(f.order).toContain("ROLLBACK")
  })
  it("does not publish a completed deletion after SQL rollback", async () => {
    const f = fixture()
    f.fail.sql()
    await expect(f.pool.query("DELETE FROM session")).rejects.toThrow(
      "constraint"
    )
    expect(f.backend.complete).not.toHaveBeenCalled()
    expect(f.backend.abort).toHaveBeenCalledOnce()
  })
  it("leaves an unresolved prepare after an ambiguous COMMIT", async () => {
    const f = fixture()
    f.fail.commit()
    await expect(f.pool.query("DELETE FROM session")).rejects.toThrow(
      "lost commit"
    )
    expect(f.backend.complete).not.toHaveBeenCalled()
    expect(f.backend.abort).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledWith(expect.any(Error))
  })
  it("leaves an unresolved prepare after an unsuccessful rollback", async () => {
    const f = fixture()
    f.fail.sql()
    f.fail.rollback()
    await expect(f.pool.query("DELETE FROM session")).rejects.toThrow()
    expect(f.backend.abort).not.toHaveBeenCalled()
  })
  it("returns failure if publication fails after a confirmed COMMIT, preserving its receipt", async () => {
    const f = fixture()
    vi.mocked(f.backend.complete).mockRejectedValue(new Error("R2 unavailable"))
    await expect(
      f.pool.query("UPDATE apikey SET enabled=false")
    ).rejects.toThrow("PUBLICATION_PENDING")
    expect(f.order).toContain("COMMIT")
    expect(f.backend.abort).not.toHaveBeenCalled()
  })
  it("uses one independent operation for a multi-statement transaction", async () => {
    const f = fixture(),
      client = await f.pool.connect()
    await client.query("BEGIN")
    await client.query("UPDATE apikey SET enabled=false")
    await client.query("DELETE FROM session")
    await client.query("COMMIT")
    expect(f.backend.prepare).toHaveBeenCalledOnce()
    expect(f.backend.complete).toHaveBeenCalledOnce()
  })
  it("does not mislabel PostgreSQL implicit rollback as committed", async () => {
    const f = fixture(),
      client = await f.pool.connect()
    await client.query("BEGIN")
    await client.query("DELETE FROM session")
    f.fail.commitAsRollback()
    await client.query("COMMIT")
    expect(f.backend.complete).not.toHaveBeenCalled()
    expect(f.backend.abort).toHaveBeenCalledOnce()
  })
  it("re-prepares after rolling back the first destructive statement to a savepoint", async () => {
    const f = fixture(),
      client = await f.pool.connect()
    await client.query("BEGIN")
    await client.query("SAVEPOINT nested")
    await client.query("DELETE FROM session")
    await client.query("ROLLBACK TO SAVEPOINT nested")
    await client.query("DELETE FROM session")
    await client.query("COMMIT")
    expect(f.backend.prepare).toHaveBeenCalledTimes(2)
    expect(f.backend.abort).toHaveBeenCalledOnce()
    expect(f.backend.complete).toHaveBeenCalledOnce()
  })
  it("leaves ordinary reads on the existing fast path", async () => {
    const f = fixture()
    await f.pool.query("SELECT 1")
    expect(f.backend.prepare).not.toHaveBeenCalled()
  })
})
