import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import {
  keyCapsule,
  publicRecoveryKeyFingerprint,
} from "../src/application/recovery/key-capsule.server"
import { STAGING } from "../../../packages/environment/staging-environment"
import { VercelPrivateFileBlobStore } from "../src/adapters/files/vercel-private-file-blob-store.server"
import {
  decryptEntry,
  openManifest,
  readRecoveryKey,
} from "./lib/recovery-archive"
import { recoveryIdentity, recoveryManifest } from "./lib/recovery-contract"
import {
  generateRecoveryIdentity,
  openRecoveryKeyCapsule,
  unwrapRecoveryKey,
  wrapRecoveryKey,
} from "./lib/recovery-key-custody"
import { captureRecovery, restoreRecovery } from "./lib/recovery"
import {
  downloadRecoverySet,
  r2Config,
  uploadRecoverySet,
} from "./lib/recovery-r2"

const configSchema = z
  .object({
    identity: recoveryIdentity,
    connectionFile: z.string(),
    blobCredentialsFile: z.string(),
    credentialKeyFile: z.string().optional(),
    publicKeyFile: z.string().optional(),
    privateKeyFile: z.string().optional(),
    journalKeyFile: z.string().optional(),
    pgDump: z.string().default("pg_dump"),
    pgRestore: z.string().default("pg_restore"),
    r2CredentialsFile: z.string().optional(),
    restoredCredentialKeyFile: z.string().optional(),
    restoredJournalKeyFile: z.string().optional(),
    encryptedKeysFile: z.string().optional(),
    keyExportUrl: z.string().url().optional(),
    operatorTokenFile: z.string().optional(),
  })
  .strict()

async function writeRecoveredSecret(path: string, value: string) {
  try {
    await writeFile(path, value, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error
    const info = await stat(path)
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (await readFile(path, "utf8")).trim() !== value
    )
      throw new Error("RECOVERY_KEY_OUTPUT_CONFLICT")
  }
}

async function run() {
  const [mode, configPath, argument, extra, incidentAt] = process.argv.slice(2)
  if (mode === "init-key") {
    if (!configPath || !argument)
      throw new Error("Usage: recovery.ts init-key PRIVATE_FILE PUBLIC_FILE")
    await generateRecoveryIdentity(configPath, argument)
    console.log(
      JSON.stringify({
        created: true,
        privateKeyFile: resolve(configPath),
        publicKeyFile: resolve(argument),
        next: "Store the private key in your password manager; capture requires only the public key.",
      })
    )
    return
  }
  if (
    !configPath ||
    !argument ||
    ![
      "capture",
      "restore",
      "restore-reset",
      "upload",
      "download",
      "export-keys",
      "unseal-keys",
    ].includes(mode)
  )
    throw new Error(
      "Usage: recovery.ts capture|restore|upload|download CONFIG DIRECTORY_OR_PREFIX [DIRECTORY_OR_JOURNAL] [INCIDENT_UTC]"
    )
  const config = configSchema.parse(
    JSON.parse(await readFile(configPath, "utf8"))
  )
  if (mode === "unseal-keys") {
    if (
      !config.privateKeyFile ||
      !config.restoredCredentialKeyFile ||
      !config.restoredJournalKeyFile
    )
      throw new Error("RECOVERY_KEY_OUTPUT_PATHS_REQUIRED")
    const temp = await mkdtemp(join(tmpdir(), "forge-recovery-key-unseal-"))
    try {
      const key = await unwrapRecoveryKey(argument, config.privateKeyFile),
        manifest = recoveryManifest.parse(
          await openManifest(argument, temp, key)
        )
      if (
        Date.now() >= Date.parse(manifest.expiresAt) ||
        Date.parse(manifest.expiresAt) >
          Date.parse(manifest.capturedAt) + 35 * 86400000
      )
        throw new Error("RECOVERY_CAPTURE_WINDOW")
      await decryptEntry(
        argument,
        manifest.credentialKey,
        join(temp, "credential-key"),
        key
      )
      let credentialKey = (
          await readFile(join(temp, "credential-key"), "utf8")
        ).trim(),
        journalKey: Buffer | undefined
      if (manifest.credentialKeyFormat === "rsa-capsule") {
        const keys = await openRecoveryKeyCapsule(
          keyCapsule.parse(JSON.parse(credentialKey)).encryptedKeys,
          config.privateKeyFile
        )
        credentialKey = keys.modelCredentialKek
        journalKey = Buffer.from(keys.journalSigningKey, "base64")
      }
      if (manifest.journalKey) {
        await decryptEntry(
          argument,
          manifest.journalKey,
          join(temp, "journal-key"),
          key
        )
        journalKey = Buffer.from(
          (await readFile(join(temp, "journal-key"), "utf8")).trim(),
          "base64"
        )
      }
      if (!journalKey || journalKey.length !== 32)
        throw new Error("RECOVERY_JOURNAL_SIGNING_KEY_MISSING")
      await writeRecoveredSecret(
        config.restoredCredentialKeyFile,
        credentialKey
      )
      await writeRecoveredSecret(
        config.restoredJournalKeyFile,
        journalKey.toString("base64")
      )
      console.log(
        JSON.stringify({
          recoveredKeys: true,
          source: manifest.source,
          sourceRevision: manifest.sourceRevision,
          serviceValidated: false,
        })
      )
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
    return
  }
  if (mode === "export-keys") {
    if (
      !config.keyExportUrl ||
      !config.operatorTokenFile ||
      !config.publicKeyFile
    )
      throw new Error("RECOVERY_KEY_EXPORT_CONFIGURATION")
    const url = new URL(config.keyExportUrl)
    if (
      url.pathname !== "/api/internal/recovery-key-export" ||
      (![
        "https://app.forgenow.tech",
        "https://forge-app-mauve.vercel.app",
        STAGING.webOrigin,
      ].includes(url.origin) &&
        !["localhost", "127.0.0.1"].includes(url.hostname))
    )
      throw new Error("RECOVERY_KEY_EXPORT_ORIGIN")
    const token = (await readFile(config.operatorTokenFile, "utf8")).trim(),
      challenge = randomBytes(16).toString("hex")
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("RECOVERY_KEY_EXPORT_TOKEN")
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-environment-check-challenge": challenge,
      },
    })
    if (!response.ok)
      throw new Error("RECOVERY_KEY_EXPORT_DENIED_OR_UNAVAILABLE")
    const capsule = keyCapsule.parse(await response.json())
    if (
      capsule.challenge !== challenge ||
      JSON.stringify(capsule.source) !== JSON.stringify(config.identity) ||
      capsule.publicKeyFingerprint !==
        publicRecoveryKeyFingerprint(
          await readFile(config.publicKeyFile, "utf8")
        )
    )
      throw new Error("RECOVERY_KEY_CAPSULE_ATTESTATION_MISMATCH")
    await writeFile(argument, JSON.stringify(capsule), {
      flag: "wx",
      mode: 0o600,
    })
    console.log(
      JSON.stringify({
        exported: true,
        sourceRevision: capsule.sourceRevision,
        credentialCounts: capsule.credentialCounts,
        publicKeyFingerprint: capsule.publicKeyFingerprint,
      })
    )
    return
  }
  const readR2 = async () => {
    if (!config.r2CredentialsFile)
      throw new Error("RECOVERY_R2_CREDENTIALS_REQUIRED")
    return r2Config.parse(
      JSON.parse(await readFile(config.r2CredentialsFile, "utf8"))
    )
  }
  if (mode === "download") {
    if (!extra) throw new Error("RECOVERY_DOWNLOAD_DIRECTORY_REQUIRED")
    console.log(
      JSON.stringify(await downloadRecoverySet(await readR2(), argument, extra))
    )
    return
  }
  if (mode === "upload") {
    if (!config.privateKeyFile)
      throw new Error("RECOVERY_UPLOAD_MANIFEST_VERIFICATION_KEY_REQUIRED")
    const temp = await mkdtemp(join(tmpdir(), "forge-recovery-manifest-"))
    try {
      const key = await unwrapRecoveryKey(argument, config.privateKeyFile)
      const manifest = recoveryManifest.parse(
        await openManifest(argument, temp, key)
      )
      console.log(
        JSON.stringify(
          await uploadRecoverySet(await readR2(), argument, manifest)
        )
      )
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
    return
  }
  const connection = (await readFile(config.connectionFile, "utf8")).trim()
  const blobEnv = z
    .object({ BLOB_STORE_ID: z.string(), BLOB_READ_WRITE_TOKEN: z.string() })
    .strict()
    .parse(JSON.parse(await readFile(config.blobCredentialsFile, "utf8")))
  if (blobEnv.BLOB_STORE_ID !== config.identity.storeId)
    throw new Error("RECOVERY_BLOB_IDENTITY")
  const blobs = new VercelPrivateFileBlobStore(blobEnv)
  if (mode === "capture") {
    if (
      !config.publicKeyFile ||
      (!config.credentialKeyFile && !config.encryptedKeysFile)
    )
      throw new Error("RECOVERY_CAPTURE_KEYS_REQUIRED")
    if (
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim()
    )
      throw new Error("RECOVERY_SOURCE_CHECKOUT_NOT_CLEAN")
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()
    await mkdir(argument, { mode: 0o700 })
    const key = await wrapRecoveryKey(argument, config.publicKeyFile)
    const manifest = await captureRecovery({
      directory: argument,
      connection,
      identity: config.identity,
      sourceRevision,
      blobs,
      key,
      credentialKey: config.encryptedKeysFile
        ? undefined
        : config.credentialKeyFile
          ? (await readFile(config.credentialKeyFile, "utf8")).trim()
          : undefined,
      encryptedKeys: config.encryptedKeysFile
        ? keyCapsule.parse(
            JSON.parse(await readFile(config.encryptedKeysFile, "utf8"))
          )
        : undefined,
      publicKeyFingerprint: publicRecoveryKeyFingerprint(
        await readFile(config.publicKeyFile, "utf8")
      ),
      pgDump: config.pgDump,
      journalKey:
        !config.encryptedKeysFile && config.journalKeyFile
          ? await readRecoveryKey(config.journalKeyFile)
          : undefined,
    })
    const uploaded = config.r2CredentialsFile
      ? await uploadRecoverySet(await readR2(), argument, manifest)
      : null
    console.log(
      JSON.stringify({
        id: manifest.id,
        capturedAt: manifest.capturedAt,
        completedAt: manifest.completedAt,
        expiresAt: manifest.expiresAt,
        sourceRevision,
        tables: manifest.tables.length,
        files: manifest.files.length,
        credentialCounts: manifest.credentialCounts,
        uploaded,
      })
    )
    return
  }
  if (!config.privateKeyFile || !extra || !incidentAt)
    throw new Error(
      "RECOVERY_RESTORE_PRIVATE_KEY_JOURNAL_AND_INCIDENT_REQUIRED"
    )
  const result = await restoreRecovery({
    directory: argument,
    connection,
    identity: config.identity,
    blobs,
    key: await unwrapRecoveryKey(argument, config.privateKeyFile),
    journal: JSON.parse(await readFile(extra, "utf8")),
    journalKey: config.journalKeyFile
      ? await readRecoveryKey(config.journalKeyFile)
      : undefined,
    incidentAt,
    pgRestore: config.pgRestore,
    resetIsolatedTarget: mode === "restore-reset",
    privateKeyFile: config.privateKeyFile,
  })
  if (config.restoredCredentialKeyFile)
    await writeRecoveredSecret(
      config.restoredCredentialKeyFile,
      result.credentialKey
    )
  if (config.restoredJournalKeyFile)
    await writeRecoveredSecret(
      config.restoredJournalKeyFile,
      result.journalKey.toString("base64")
    )
  // Never spread result: credentialKey is secret, and manifest has row identities.
  console.log(
    JSON.stringify({
      id: result.manifest.id,
      reconciled: result.reconciliation,
      suppressed: result.suppressed,
      expiry: result.expiry,
      serviceValidated: false,
      next: "Run current authenticated journeys and expiry checks before reporting RTO or releasing service.",
    })
  )
}
try {
  await run()
} catch (error) {
  // Library/driver exceptions can contain secret values. Only controlled error
  // codes leave this CLI; detailed diagnostics stay in the private run context.
  const message =
    error instanceof Error &&
    /^RECOVERY_[A-Z_]+(?::[a-zA-Z0-9_.,:/-]+)?$/.test(error.message)
      ? error.message
      : "RECOVERY_FAILED: no complete recovery or release is confirmed."
  console.error(message)
  process.exitCode = 1
}
