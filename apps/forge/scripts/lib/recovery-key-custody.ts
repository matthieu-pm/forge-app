import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CAPSULE_LABEL,
  recoveryKeys,
} from "../../src/application/recovery/key-capsule.server"

/** Capture needs only the public key. The private recovery key stays
 * with the operator/password manager, outside Vercel and the backup bucket. */
export async function generateRecoveryIdentity(
  privatePath: string,
  publicPath: string
) {
  for (const path of [privatePath, publicPath]) {
    const exists = await stat(path).then(
      () => true,
      (error) => {
        if (error?.code === "ENOENT") return false
        throw error
      }
    )
    if (exists) throw new Error("RECOVERY_KEY_IDENTITY_ALREADY_EXISTS")
  }
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  await writeFile(privatePath, pair.privateKey, { flag: "wx", mode: 0o600 })
  try {
    await writeFile(publicPath, pair.publicKey, { flag: "wx", mode: 0o644 })
  } catch (error) {
    await rm(privatePath, { force: true })
    throw error
  }
}
async function privateKeyBytes(path: string) {
  const info = await stat(path).catch(() => {
    throw new Error("RECOVERY_PRIVATE_KEY_MISSING")
  })
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("RECOVERY_PRIVATE_KEY_PERMISSIONS")
  return readFile(path)
}
export async function wrapRecoveryKey(
  directory: string,
  publicKeyPath: string
) {
  const key = randomBytes(32)
  const wrapped = publicEncrypt(
    {
      key: await readFile(publicKeyPath),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
      oaepLabel: Buffer.from("forge-recovery-v1"),
    },
    key
  )
  await writeFile(join(directory, "wrapped-key.bin"), wrapped, {
    flag: "wx",
    mode: 0o600,
  })
  return key
}
export async function unwrapRecoveryKey(
  directory: string,
  privateKeyPath: string
) {
  const privateKey = await privateKeyBytes(privateKeyPath)
  try {
    const key = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
        oaepLabel: Buffer.from("forge-recovery-v1"),
      },
      await readFile(join(directory, "wrapped-key.bin"))
    )
    if (key.length !== 32) throw new Error("length")
    return key
  } catch {
    throw new Error("RECOVERY_PRIVATE_KEY_MISSING_OR_WRONG")
  }
}

export async function openRecoveryKeyCapsule(
  encryptedKeys: string,
  privateKeyPath: string
) {
  const privateKey = await privateKeyBytes(privateKeyPath)
  try {
    return recoveryKeys.parse(
      JSON.parse(
        privateDecrypt(
          {
            key: privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
            oaepLabel: Buffer.from(CAPSULE_LABEL),
          },
          Buffer.from(encryptedKeys, "base64")
        ).toString("utf8")
      )
    )
  } catch {
    throw new Error("RECOVERY_KEY_CAPSULE_UNREADABLE")
  }
}
