import "@tanstack/react-start/server-only"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const VERSION = "forge-model-secret:v1"

export interface ModelSecretVault {
  seal: (secret: string, context: string) => Promise<string>
  open: (reference: string, context: string) => Promise<string>
}

function readKey(encodedKey: string | undefined) {
  if (!encodedKey) {
    throw new Error(
      "FORGE_MODEL_CREDENTIAL_KEK is required to store server model credentials."
    )
  }
  const key = Buffer.from(encodedKey, "base64")
  if (key.length !== 32) {
    throw new Error(
      "FORGE_MODEL_CREDENTIAL_KEK must be a base64-encoded 32-byte key."
    )
  }
  return key
}

export class EnvelopeModelSecretVault implements ModelSecretVault {
  readonly #key: Buffer

  constructor(encodedKey = process.env.FORGE_MODEL_CREDENTIAL_KEK) {
    this.#key = readKey(encodedKey)
  }

  async seal(secret: string, context: string) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce)
    cipher.setAAD(Buffer.from(context))
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    return [
      VERSION,
      nonce.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(":")
  }

  async open(reference: string, context: string) {
    const [prefix, version, nonceValue, tagValue, ciphertextValue] =
      reference.split(":")
    if (
      `${prefix}:${version}` !== VERSION ||
      !nonceValue ||
      !tagValue ||
      !ciphertextValue
    ) {
      throw new Error("The model credential reference is invalid.")
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(nonceValue, "base64url")
    )
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  }
}
