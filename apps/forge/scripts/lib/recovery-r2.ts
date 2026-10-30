import { createReadStream, createWriteStream } from "node:fs"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { z } from "zod"
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { digest } from "./recovery-archive"
import { deletionJournal } from "./recovery-contract"
import type { DeletionJournal } from "./recovery-contract"

export const r2Config = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    bucket: z.string().regex(/^forge-recovery-[a-z0-9-]+$/),
    accessKeyId: z.string().regex(/^[a-f0-9]{32}$/),
    secretAccessKey: z.string().min(32),
  })
  .strict()
export type R2Config = z.infer<typeof r2Config>
const descriptor = z
  .object({
    version: z.literal(1),
    capturedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    files: z.array(
      z.object({
        name: z
          .string()
          .regex(
            /^(?:[a-z0-9][a-z0-9.-]{0,127}\.aes|manifest\.json|wrapped-key\.bin)$/
          ),
        size: z.number().int().positive(),
      })
    ),
  })
  .strict()
function client(config: R2Config) {
  r2Config.parse(config)
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
}
function assertPrefix(prefix: string) {
  if (
    !/^sets\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\/[a-f0-9-]{36}$/.test(prefix)
  )
    throw new Error("RECOVERY_R2_PREFIX")
}

async function streamDigest(stream: AsyncIterable<Uint8Array>) {
  const hash = createHash("sha256")
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}

async function existingEntry(
  s3: S3Client,
  bucket: string,
  key: string,
  path: string,
  metadata: Record<string, string>
) {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    )
    if (
      !response.Body ||
      response.ContentLength !== (await stat(path)).size ||
      Object.entries(metadata).some(([k, v]) => response.Metadata?.[k] !== v)
    )
      throw new Error("RECOVERY_R2_EXISTING_ENTRY_CONFLICT")
    if (
      (await streamDigest(response.Body as AsyncIterable<Uint8Array>)) !==
      (await streamDigest(createReadStream(path)))
    )
      throw new Error("RECOVERY_R2_EXISTING_ENTRY_INTEGRITY")
    return true
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "$metadata" in error &&
      (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404
    )
      return false
    throw error
  }
}

/** One 16 MiB part in memory. Unknown outcomes retry the same immutable set;
 * incomplete multipart uploads are aborted, never called a successful backup. */
async function uploadFile(
  s3: S3Client,
  bucket: string,
  key: string,
  path: string,
  metadata: Record<string, string>
) {
  const length = (await stat(path)).size
  if (await existingEntry(s3, bucket, key, path, metadata)) return
  if (length <= 16 * 1024 * 1024) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: await readFile(path),
        ContentLength: length,
        IfNoneMatch: "*",
        Metadata: metadata,
      })
    )
    return
  }
  const upload = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      Metadata: metadata,
    })
  )
  const parts: Array<{ ETag: string; PartNumber: number }> = []
  try {
    const { open } = await import("node:fs/promises"),
      file = await open(path, "r")
    try {
      for (
        let offset = 0, n = 1;
        offset < length;
        offset += 16 * 1024 * 1024, n++
      ) {
        const bytes = Buffer.alloc(Math.min(16 * 1024 * 1024, length - offset))
        await file.read(bytes, 0, bytes.length, offset)
        const part = await s3.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: upload.UploadId,
            PartNumber: n,
            Body: bytes,
            ContentLength: bytes.length,
          })
        )
        if (!part.ETag) throw new Error("RECOVERY_R2_PART")
        parts.push({ ETag: part.ETag, PartNumber: n })
      }
    } finally {
      await file.close()
    }
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: upload.UploadId,
        MultipartUpload: { Parts: parts },
        IfNoneMatch: "*",
      })
    )
  } catch (error) {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: upload.UploadId,
      })
    )
    throw error
  }
}

export async function uploadDeletionJournal(
  config: R2Config,
  journal: DeletionJournal
) {
  deletionJournal.parse(journal)
  if (config.bucket !== "forge-recovery-deletion-journal")
    throw new Error("RECOVERY_JOURNAL_BUCKET")
  const name = `journal/${journal.through.replaceAll(":", "-")}-${digest(JSON.stringify(journal))}.json`
  const s3 = client(config)
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: name,
        Body: JSON.stringify(journal),
        IfNoneMatch: "*",
        Metadata: { through: journal.through },
      })
    )
    const readback = await s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: name })
    )
    if ((await readback.Body?.transformToString()) !== JSON.stringify(journal))
      throw new Error("RECOVERY_JOURNAL_READBACK")
    return name
  } finally {
    s3.destroy()
  }
}
export async function downloadDeletionJournal(config: R2Config, name: string) {
  if (
    config.bucket !== "forge-recovery-deletion-journal" ||
    !/^journal\/[a-zA-Z0-9.:-]+\.json$/.test(name)
  )
    throw new Error("RECOVERY_JOURNAL_OBJECT")
  const s3 = client(config)
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: name })
    )
    return deletionJournal.parse(
      JSON.parse(await response.Body!.transformToString())
    )
  } finally {
    s3.destroy()
  }
}

/** Independently verifies provider disappearance. Original capture time comes
 * from the immutable set key, so copy/re-upload cannot renew the restore clock. */
export async function pruneRecoverySets(config: R2Config, now = new Date()) {
  if (config.bucket !== "forge-recovery-backups")
    throw new Error("RECOVERY_PRUNE_BUCKET")
  const s3 = client(config)
  let cursor: string | undefined,
    deleted = 0,
    checked = 0
  try {
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: "sets/",
          ContinuationToken: cursor,
        })
      )
      for (const object of page.Contents ?? []) {
        const key = object.Key ?? "",
          parts = key.split("/"),
          prefix = parts.slice(0, 3).join("/")
        assertPrefix(prefix)
        const date = parts[1].replace(
            /T(\d{2})-(\d{2})-(\d{2})Z$/,
            "T$1:$2:$3Z"
          ),
          captured = Date.parse(date)
        if (!Number.isFinite(captured) || captured > now.getTime())
          throw new Error("RECOVERY_PRUNE_CAPTURE_TIME")
        checked++
        if (now.getTime() < captured + 33 * 86400000) continue
        await s3.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: key })
        )
        try {
          await s3.send(
            new HeadObjectCommand({ Bucket: config.bucket, Key: key })
          )
          throw new Error("RECOVERY_PRUNE_STILL_PRESENT")
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "$metadata" in error &&
            (error.$metadata as { httpStatusCode?: number }).httpStatusCode ===
              404
          ))
            throw error
        }
        deleted++
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (cursor)
    return { checked, deleted, verifiedAt: now.toISOString() }
  } finally {
    s3.destroy()
  }
}

export async function uploadRecoverySet(
  config: R2Config,
  directory: string,
  identity: { id: string; capturedAt: string; expiresAt: string }
) {
  const captured = Date.parse(identity.capturedAt),
    expires = Date.parse(identity.expiresAt)
  if (
    !Number.isFinite(captured) ||
    expires > captured + 35 * 86400000 ||
    expires <= Date.now() ||
    captured > Date.now()
  )
    throw new Error("RECOVERY_R2_AGE")
  if (Date.now() - captured > 3600000)
    throw new Error("RECOVERY_R2_CAPTURE_TOO_OLD_TO_UPLOAD")
  const prefix = `sets/${identity.capturedAt.slice(0, 19).replaceAll(":", "-")}Z/${identity.id}`
  assertPrefix(prefix)
  const names = (await readdir(directory)).sort()
  const files = []
  for (const name of names)
    files.push({ name, size: (await stat(join(directory, name))).size })
  const record = descriptor.parse({
    version: 1,
    capturedAt: identity.capturedAt,
    expiresAt: identity.expiresAt,
    files,
  })
  for (const required of [
    "manifest.aes",
    "manifest.json",
    "database.aes",
    "credential-key.aes",
    "wrapped-key.bin",
  ])
    if (!names.includes(required))
      throw new Error(`RECOVERY_R2_ENTRY_MISSING:${required}`)
  const s3 = client(config)
  try {
    for (const file of record.files) {
      await uploadFile(
        s3,
        config.bucket,
        `${prefix}/${file.name}`,
        join(directory, file.name),
        { "captured-at": identity.capturedAt, "expires-at": identity.expiresAt }
      )
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: `${prefix}/${file.name}`,
        })
      )
      if (
        head.ContentLength !== file.size ||
        head.Metadata?.["captured-at"] !== identity.capturedAt ||
        head.Metadata["expires-at"] !== identity.expiresAt
      )
        throw new Error(`RECOVERY_R2_READBACK:${file.name}`)
      if (
        !(await existingEntry(
          s3,
          config.bucket,
          `${prefix}/${file.name}`,
          join(directory, file.name),
          {
            "captured-at": identity.capturedAt,
            "expires-at": identity.expiresAt,
          }
        ))
      )
        throw new Error(`RECOVERY_R2_READBACK:${file.name}`)
    }
    // Publish the commit record only after all durable entries exist.
    const committed = await s3
      .send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: `${prefix}/set.json`,
        })
      )
      .then(async (response) => {
        if (
          (await response.Body?.transformToString()) !== JSON.stringify(record)
        )
          throw new Error("RECOVERY_R2_COMMIT_CONFLICT")
        return true
      })
      .catch((error) => {
        if (error?.$metadata?.httpStatusCode === 404) return false
        throw error
      })
    if (!committed)
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: `${prefix}/set.json`,
          Body: JSON.stringify(record),
          IfNoneMatch: "*",
          Metadata: {
            "captured-at": identity.capturedAt,
            "expires-at": identity.expiresAt,
          },
        })
      )
    return { prefix, files: record.files.length }
  } finally {
    s3.destroy()
  }
}

export async function downloadRecoverySet(
  config: R2Config,
  prefix: string,
  directory: string
) {
  assertPrefix(prefix)
  await mkdir(directory, { mode: 0o700 })
  const s3 = client(config)
  try {
    const commit = await s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: `${prefix}/set.json` })
    )
    const record = descriptor.parse(
      JSON.parse(await commit.Body!.transformToString())
    )
    if (
      Date.now() >= Date.parse(record.expiresAt) ||
      Date.parse(record.expiresAt) >
        Date.parse(record.capturedAt) + 35 * 86400000
    )
      throw new Error("RECOVERY_R2_EXPIRED")
    if (new Set(record.files.map((f) => f.name)).size !== record.files.length)
      throw new Error("RECOVERY_R2_DUPLICATE_ENTRY")
    for (const file of record.files) {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: `${prefix}/${file.name}`,
        })
      )
      if (!response.Body || response.ContentLength !== file.size)
        throw new Error(`RECOVERY_R2_MISSING:${file.name}`)
      await pipeline(
        response.Body as NodeJS.ReadableStream,
        createWriteStream(join(directory, file.name), {
          flags: "wx",
          mode: 0o600,
        })
      )
    }
    return {
      prefix,
      files: record.files.length,
      descriptorSha256: digest(JSON.stringify(record)),
    }
  } finally {
    s3.destroy()
  }
}
