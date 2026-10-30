import "@tanstack/react-start/server-only"
import {
  constants,
  createHash,
  createPublicKey,
  publicEncrypt,
} from "node:crypto"
import { z } from "zod"
import { handleEnvironmentCheck } from "../../../../../packages/environment/operator-check"
import { journalSource } from "./journal"
import { verifyCredentialCoverage } from "./credential-coverage.server"
import type { CredentialClient } from "./credential-coverage.server"

const encodedKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
export const recoveryKeys = z
  .object({
    version: z.literal(1),
    modelCredentialKek: encodedKey,
    journalSigningKey: encodedKey,
  })
  .strict()
export const keyCapsule = z
  .object({
    version: z.literal(1),
    source: journalSource,
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    createdAt: z.string().datetime(),
    challenge: z.string().regex(/^[a-f0-9]{32}$/),
    publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    credentialCounts: z
      .object({
        model: z.number().int().nonnegative(),
        meeting: z.number().int().nonnegative(),
      })
      .strict(),
    encryptedKeys: z
      .string()
      .regex(/^[A-Za-z0-9+/]+=*$/)
      .max(4096),
  })
  .strict()
export const CAPSULE_LABEL = "forge-recovery-key-capsule-v1"
export function publicRecoveryKeyFingerprint(pem: string) {
  return createHash("sha256")
    .update(createPublicKey(pem).export({ format: "der", type: "spki" }))
    .digest("hex")
}

/** The recipient public key is server configuration, never caller input. Even
 * an authorized probe receives only an RSA envelope and non-secret attestation. */
export async function collectRecoveryKeyCapsule(
  env: Record<string, string | undefined>,
  client: CredentialClient,
  challenge: string
) {
  const keys = recoveryKeys.parse({
    version: 1,
    modelCredentialKek: env.FORGE_MODEL_CREDENTIAL_KEK,
    journalSigningKey: env.FORGE_RECOVERY_JOURNAL_SIGNING_KEY,
  })
  const publicKey = createPublicKey(env.FORGE_RECOVERY_PUBLIC_KEY ?? "")
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  )
    throw new Error("RECOVERY_PUBLIC_KEY_INVALID")
  const identity = (
    await client.query(
      "SELECT current_database() AS database,current_setting('neon.branch_id',true) AS branch"
    )
  ).rows[0]
  const coverage = await verifyCredentialCoverage(
    client,
    keys.modelCredentialKek
  )
  const source = journalSource.parse({
    branchId: identity.branch,
    host: new URL(env.DATABASE_URL!).hostname.replace("-pooler.", "."),
    database: identity.database,
    storeId: env.BLOB_STORE_ID,
  })
  const encryptedKeys = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
      oaepLabel: Buffer.from(CAPSULE_LABEL),
    },
    Buffer.from(JSON.stringify(keys))
  ).toString("base64")
  return keyCapsule.parse({
    version: 1,
    source,
    sourceRevision: env.FORGE_SOURCE_REVISION ?? env.VERCEL_GIT_COMMIT_SHA,
    createdAt: new Date().toISOString(),
    challenge,
    publicKeyFingerprint: publicRecoveryKeyFingerprint(
      env.FORGE_RECOVERY_PUBLIC_KEY!
    ),
    credentialFingerprint: coverage.fingerprint,
    credentialCounts: coverage.counts,
    encryptedKeys,
  })
}

export function handleRecoveryKeyExport(
  request: Request,
  env: Record<string, string | undefined>,
  collect: (challenge: string) => Promise<unknown>,
  now = Date.now()
) {
  const expiry = Date.parse(env.FORGE_RECOVERY_KEY_EXPORT_EXPIRES_AT ?? "")
  // Deployment-only authority, bounded to one hour. No disabled probe touches DB.
  const enabled = expiry <= now + 3600000
  return handleEnvironmentCheck(
    request,
    {
      tokenSha256: enabled
        ? env.FORGE_RECOVERY_KEY_EXPORT_TOKEN_SHA256
        : undefined,
      expiresAt: env.FORGE_RECOVERY_KEY_EXPORT_EXPIRES_AT,
    },
    collect,
    now
  )
}
