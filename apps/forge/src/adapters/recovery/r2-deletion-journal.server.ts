import "@tanstack/react-start/server-only"
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { z } from "zod"
import {
  journalSource,
  recoveryEvent,
  signJournalRecord,
  sourceDigest,
  verifyJournalRecord,
} from "../../application/recovery/journal"
import type {
  DeletionJournalBackend,
  JournalRecord,
  JournalSource,
  RecoveryEvent,
} from "../../application/recovery/journal"

export const deletionJournalConfig = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    bucket: z.literal("forge-recovery-deletion-journal"),
    accessKeyId: z.string().regex(/^[a-f0-9]{32}$/),
    secretAccessKey: z.string().min(32),
    signingKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  })
  .strict()
export class R2DeletionJournal implements DeletionJournalBackend {
  readonly #client: S3Client
  readonly #key: Buffer
  readonly #bucket: string
  constructor(config: z.infer<typeof deletionJournalConfig>) {
    deletionJournalConfig.parse(config)
    this.#bucket = config.bucket
    this.#key = Buffer.from(config.signingKey, "base64")
    this.#client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
    })
  }
  #prefix(source: JournalSource, operation: string) {
    return `journal/operations/${sourceDigest(source)}/${operation}/`
  }
  #pending(source: JournalSource, operation: string) {
    return `pending/operations/${sourceDigest(source)}/${operation}/prepared.json`
  }
  async #write(record: JournalRecord, name: string) {
    const key =
        record.kind === "prepared"
          ? this.#pending(record.source, record.operationId)
          : this.#prefix(record.source, record.operationId) + name,
      body = JSON.stringify(signJournalRecord(record, this.#key))
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: Buffer.from(body),
          IfNoneMatch: "*",
        }),
        { abortSignal: AbortSignal.timeout(15000) }
      )
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "$metadata" in error &&
        (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 412
      ))
        throw new Error("RECOVERY_JOURNAL_UNAVAILABLE")
      const existing = await this.#read(key)
      // A retry can have a new wall-clock time; effect identity and content must agree.
      const { at: _, ...a } = existing,
        { at: __, ...b } = record
      if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error("RECOVERY_JOURNAL_EFFECT_CONFLICT")
    }
  }
  async #read(key: string) {
    const result = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(15000) }
    )
    return verifyJournalRecord(
      JSON.parse(await result.Body!.transformToString()),
      this.#key
    )
  }
  async prepare(operationId: string, source: JournalSource) {
    await this.#write(
      {
        version: 1,
        source: journalSource.parse(source),
        operationId,
        at: new Date().toISOString(),
        kind: "prepared",
      },
      "prepared.json"
    )
  }
  async abort(operationId: string, source: JournalSource) {
    await this.#write(
      {
        version: 1,
        source,
        operationId,
        at: new Date().toISOString(),
        kind: "aborted",
      },
      "aborted.json"
    )
    await this.#client.send(
      new DeleteObjectCommand({
        Bucket: this.#bucket,
        Key: this.#pending(source, operationId),
      }),
      { abortSignal: AbortSignal.timeout(15000) }
    )
  }
  async complete(
    operationId: string,
    source: JournalSource,
    events: AsyncIterable<Array<RecoveryEvent>>
  ) {
    const chunks: Array<string> = []
    for await (const batch of events) {
      const name = `chunk-${chunks.length}.json`
      chunks.push(name)
      await this.#write(
        {
          version: 1,
          source,
          operationId,
          at: new Date().toISOString(),
          kind: "chunk",
          events: batch.map((e) => recoveryEvent.parse(e)),
        },
        name
      )
    }
    await this.#write(
      {
        version: 1,
        source,
        operationId,
        at: new Date().toISOString(),
        kind: "completed",
        chunks,
      },
      "completed.json"
    )
    await this.#client.send(
      new DeleteObjectCommand({
        Bucket: this.#bucket,
        Key: this.#pending(source, operationId),
      }),
      { abortSignal: AbortSignal.timeout(15000) }
    )
  }
  /** Source writes must have stopped. Incomplete prepared operations require
   * receipt/outcome reconciliation; guessing "nothing happened" is forbidden. */
  async readForRestore(source: JournalSource, capturedAt: string) {
    const prefix = `journal/operations/${sourceDigest(source)}/`,
      pendingPrefix = `pending/operations/${sourceDigest(source)}/`
    const objects = new Map<string, number>()
    for (const base of [prefix, pendingPrefix]) {
      let cursor: string | undefined
      do {
        const page = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            Prefix: base,
            ContinuationToken: cursor,
          }),
          { abortSignal: AbortSignal.timeout(15000) }
        )
        for (const object of page.Contents ?? [])
          objects.set(
            object.Key!,
            object.LastModified?.getTime() ?? Number.POSITIVE_INFINITY
          )
        cursor = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (cursor)
    }
    const operations = new Set(
      [...objects.keys()].map((key) =>
        key.startsWith(prefix)
          ? key.slice(prefix.length).split("/")[0]
          : key.slice(pendingPrefix.length).split("/")[0]
      )
    )
    const events: Array<RecoveryEvent> = []
    for (const operationId of operations) {
      if (!z.string().uuid().safeParse(operationId).success)
        throw new Error("RECOVERY_JOURNAL_OPERATION_IDENTITY")
      const base = this.#prefix(source, operationId),
        completeKey = base + "completed.json",
        abortKey = base + "aborted.json"
      const preparedKey = objects.has(this.#pending(source, operationId))
        ? this.#pending(source, operationId)
        : base + "prepared.json"
      if (objects.has(completeKey) && objects.has(abortKey))
        throw new Error("RECOVERY_JOURNAL_CONFLICTING_OUTCOME")
      if (objects.has(completeKey) || objects.has(abortKey)) {
        const key = objects.has(completeKey) ? completeKey : abortKey
        // Old completed records are outside this snapshot's replay horizon. The
        // buffer includes clock skew and avoids false gaps during 365-day expiry.
        if (objects.get(key)! < Date.parse(capturedAt) - 3600000) continue
        const outcome = await this.#read(key)
        if (
          outcome.operationId !== operationId ||
          JSON.stringify(outcome.source) !== JSON.stringify(source) ||
          outcome.kind !== (key === completeKey ? "completed" : "aborted")
        )
          throw new Error("RECOVERY_JOURNAL_SOURCE")
        if (outcome.kind === "aborted") continue
        for (const name of outcome.chunks ?? []) {
          if (!objects.has(base + name))
            throw new Error(`RECOVERY_JOURNAL_CHUNK_MISSING:${operationId}`)
          const chunk = await this.#read(base + name)
          if (
            chunk.kind !== "chunk" ||
            chunk.operationId !== operationId ||
            JSON.stringify(chunk.source) !== JSON.stringify(source)
          )
            throw new Error("RECOVERY_JOURNAL_SOURCE")
          events.push(...(chunk.events ?? []))
        }
      } else if (objects.has(preparedKey)) {
        const prepared = await this.#read(preparedKey)
        if (
          prepared.kind !== "prepared" ||
          prepared.operationId !== operationId ||
          JSON.stringify(prepared.source) !== JSON.stringify(source)
        )
          throw new Error("RECOVERY_JOURNAL_OPERATION_IDENTITY")
        throw new Error(`RECOVERY_JOURNAL_UNRESOLVED:${operationId}`)
      } else {
        const newest = Math.max(
          ...[...objects.entries()]
            .filter(([key]) => key.startsWith(base))
            .map(([, at]) => at)
        )
        if (newest >= Date.parse(capturedAt) - 3600000)
          throw new Error(`RECOVERY_JOURNAL_OUTCOME_MISSING:${operationId}`)
      }
    }
    return events.sort((a, b) => a.sequence - b.sequence)
  }
  close() {
    this.#client.destroy()
  }
}

export function configuredDeletionJournal(
  env: Record<string, string | undefined> = process.env
) {
  if (env.FORGE_RECOVERY_JOURNAL_ENABLED !== "true") return null
  const parsed = deletionJournalConfig.safeParse({
    accountId: env.FORGE_RECOVERY_R2_ACCOUNT_ID,
    bucket: env.FORGE_RECOVERY_JOURNAL_BUCKET,
    accessKeyId: env.FORGE_RECOVERY_JOURNAL_ACCESS_KEY_ID,
    secretAccessKey: env.FORGE_RECOVERY_JOURNAL_SECRET_ACCESS_KEY,
    signingKey: env.FORGE_RECOVERY_JOURNAL_SIGNING_KEY,
  })
  if (!parsed.success)
    throw new Error(
      "RECOVERY_JOURNAL_CONFIGURATION_INVALID: values are redacted."
    )
  return new R2DeletionJournal(parsed.data)
}
