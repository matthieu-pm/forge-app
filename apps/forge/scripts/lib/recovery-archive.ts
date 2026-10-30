import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { Transform } from "node:stream"

const format = "forge-recovery-v1"
export const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

export function recoveryKey(encoded: string) {
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(encoded) ||
    Buffer.from(encoded, "base64").length !== 32
  )
    throw new Error("RECOVERY_KEY_INVALID: expected a base64 32-byte key.")
  return Buffer.from(encoded, "base64")
}

export async function readRecoveryKey(path: string) {
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error(
      "RECOVERY_KEY_PERMISSIONS: key must be a private regular file (0600)."
    )
  return recoveryKey((await readFile(path, "utf8")).trim())
}

function entryPath(directory: string, name: string) {
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(name))
    throw new Error("RECOVERY_ENTRY_INVALID")
  return join(directory, `${name}.aes`)
}

/** Each entry is independently authenticated, bound to its name and immutable.
 * Database dumps stream through this format; memory use is independent of DB size. */
export async function encryptEntry(
  directory: string,
  name: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  key: Buffer
) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = entryPath(directory, name)
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(`${format}:${name}`))
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 })
  output.write(nonce)
  const hash = createHash("sha256")
  let size = 0
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      size += chunk.length
      callback(null, chunk)
    },
  })
  // Leave a failed entry incomplete. Only a final authenticated manifest commits a set.
  await pipeline(source, measure, cipher, output, { end: false })
  await new Promise<void>((resolve, reject) => {
    output.once("error", reject)
    output.end(cipher.getAuthTag(), resolve)
  })
  return { entry: name, sha256: hash.digest("hex"), size }
}

/** Never expose unauthenticated plaintext to a database or object store. */
export async function decryptEntry(
  directory: string,
  entry: { entry: string; sha256: string; size: number },
  destination: string,
  key: Buffer
) {
  const source = entryPath(directory, entry.entry)
  let size: number
  try {
    size = (await stat(source)).size
  } catch {
    throw new Error(`RECOVERY_ENTRY_MISSING:${entry.entry}`)
  }
  if (size < 28) throw new Error(`RECOVERY_ENTRY_TRUNCATED:${entry.entry}`)
  const { open } = await import("node:fs/promises")
  const file = await open(source, "r")
  const nonce = Buffer.alloc(12),
    tag = Buffer.alloc(16)
  try {
    await file.read(nonce, 0, 12, 0)
    await file.read(tag, 0, 16, size - 16)
  } finally {
    await file.close()
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAAD(Buffer.from(`${format}:${entry.entry}`))
  decipher.setAuthTag(tag)
  const partial = `${destination}.partial`
  const hash = createHash("sha256")
  let actualSize = 0
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      actualSize += chunk.length
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(source, { start: 12, end: size - 17 }),
      decipher,
      measure,
      createWriteStream(partial, { flags: "wx", mode: 0o600 })
    )
    if (hash.digest("hex") !== entry.sha256 || actualSize !== entry.size)
      throw new Error("checksum")
    await rename(partial, destination)
  } catch {
    const { rm } = await import("node:fs/promises")
    await rm(partial, { force: true })
    throw new Error(`RECOVERY_ENTRY_INTEGRITY:${entry.entry}`)
  }
}

export async function sealManifest(
  directory: string,
  value: unknown,
  key: Buffer
) {
  const plain = Buffer.from(JSON.stringify(value))
  const result = await encryptEntry(directory, "manifest", [plain], key)
  // The descriptor is untrusted until GCM authentication and strict manifest validation.
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ format, ...result }),
    { flag: "wx", mode: 0o600 }
  )
}

export async function openManifest(
  directory: string,
  temporary: string,
  key: Buffer
): Promise<unknown> {
  const descriptor = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8")
  )
  if (descriptor.format !== format || descriptor.entry !== "manifest")
    throw new Error("RECOVERY_MANIFEST_INVALID")
  const target = join(temporary, "manifest.json")
  await decryptEntry(directory, descriptor, target, key)
  return JSON.parse(await readFile(target, "utf8"))
}
