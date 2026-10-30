// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await -- Promise-shaped test doubles intentionally resolve without real I/O. */
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { EnvelopeModelSecretVault } from "../agents/model-secret-vault.server"
import {
  generateRecoveryIdentity,
  openRecoveryKeyCapsule,
} from "../../../scripts/lib/recovery-key-custody"
import {
  collectRecoveryKeyCapsule,
  handleRecoveryKeyExport,
} from "./key-capsule.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
let directory: string, publicKey: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-capsule-test-"))
  await generateRecoveryIdentity(
    join(directory, "private.pem"),
    join(directory, "public.pem")
  )
  publicKey = await readFile(join(directory, "public.pem"), "utf8")
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})
describe("FOR-38 sensitive key custody", () => {
  const modelKey = randomBytes(32).toString("base64"),
    journalKey = randomBytes(32).toString("base64")
  it("exports readable model/meeting key coverage only inside the fixed recipient envelope", async () => {
    const vault = new EnvelopeModelSecretVault(modelKey),
      model = await vault.seal("fixture-model", "workspace:model"),
      meeting = await vault.seal("fixture-meeting", "meeting:workspace:meeting")
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("current_database")
        ? [{ database: "test", branch: "br-test" }]
        : sql.includes("model_connections")
          ? [
              {
                id: "model",
                workspace_id: "workspace",
                secret_reference: model,
              },
            ]
          : [{ id: "meeting", workspace_id: "workspace", secret: meeting }],
    }))
    const result = await collectRecoveryKeyCapsule(
      {
        FORGE_MODEL_CREDENTIAL_KEK: modelKey,
        FORGE_RECOVERY_JOURNAL_SIGNING_KEY: journalKey,
        FORGE_RECOVERY_PUBLIC_KEY: publicKey,
        DATABASE_URL:
          "postgresql://test:secret@ep-test-pooler.neon.tech/test?sslmode=require",
        BLOB_STORE_ID: "store_test",
        FORGE_SOURCE_REVISION: "a".repeat(40),
      },
      { query },
      "1".repeat(32)
    )
    expect(result.credentialCounts).toEqual({ model: 1, meeting: 1 })
    expect(JSON.stringify(result)).not.toContain(modelKey)
    expect(JSON.stringify(result)).not.toContain(journalKey)
    expect(JSON.stringify(result)).not.toContain("fixture-model")
    expect(
      await openRecoveryKeyCapsule(
        result.encryptedKeys,
        join(directory, "private.pem")
      )
    ).toEqual({
      version: 1,
      modelCredentialKek: modelKey,
      journalSigningKey: journalKey,
    })
  })
  it("refuses to attest unreadable encrypted credentials", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("current_database")
        ? [{ database: "test", branch: "br-test" }]
        : sql.includes("model_connections")
          ? [
              {
                id: "broken",
                workspace_id: "workspace",
                secret_reference: "not-a-vault-value",
              },
            ]
          : [],
    }))
    await expect(
      collectRecoveryKeyCapsule(
        {
          FORGE_MODEL_CREDENTIAL_KEK: modelKey,
          FORGE_RECOVERY_JOURNAL_SIGNING_KEY: journalKey,
          FORGE_RECOVERY_PUBLIC_KEY: publicKey,
          DATABASE_URL:
            "postgresql://test:secret@ep-test.neon.tech/test?sslmode=require",
          BLOB_STORE_ID: "store_test",
          FORGE_SOURCE_REVISION: "a".repeat(40),
        },
        { query },
        "1".repeat(32)
      )
    ).rejects.toThrow(
      "RECOVERY_CREDENTIALS_UNREADABLE:model_connections:broken"
    )
  })
  const token = randomBytes(32).toString("base64url"),
    now = Date.now()
  const env = {
    FORGE_RECOVERY_KEY_EXPORT_TOKEN_SHA256: createHash("sha256")
      .update(token)
      .digest("hex"),
    FORGE_RECOVERY_KEY_EXPORT_EXPIRES_AT: new Date(now + 60000).toISOString(),
  }
  const request = (auth?: string) =>
    new Request("https://app.forgenow.tech/api/internal/recovery-key-export", {
      method: "POST",
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        "x-environment-check-challenge": "1".repeat(32),
      },
    })
  it.each(["missing-token", "wrong-token", "expired", "too-long", "disabled"])(
    "does not initialize the DB for %s probes",
    async (fault) => {
      const collect = vi.fn(async () => ({ secret: "must not execute" })),
        configuration = { ...env }
      if (fault === "expired")
        configuration.FORGE_RECOVERY_KEY_EXPORT_EXPIRES_AT = new Date(
          now
        ).toISOString()
      if (fault === "too-long")
        configuration.FORGE_RECOVERY_KEY_EXPORT_EXPIRES_AT = new Date(
          now + 3600001
        ).toISOString()
      if (fault === "disabled")
        configuration.FORGE_RECOVERY_KEY_EXPORT_TOKEN_SHA256 = ""
      const response = await handleRecoveryKeyExport(
        request(
          fault === "missing-token"
            ? undefined
            : fault === "wrong-token"
              ? randomBytes(32).toString("base64url")
              : token
        ),
        configuration,
        collect,
        now
      )
      expect(response.status).toBe(404)
      expect(collect).not.toHaveBeenCalled()
    }
  )
  it("redacts key-export collection errors and prevents caching", async () => {
    const response = await handleRecoveryKeyExport(
      request(token),
      env,
      async () => {
        throw new Error(modelKey)
      },
      now
    )
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).not.toContain(modelKey)
  })
})
