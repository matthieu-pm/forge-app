import "@tanstack/react-start/server-only"
import { SignJWT, jwtVerify } from "jose"
import { FILE_GRANT_SECONDS, FileDeliveryError } from "./file-delivery-contract"
import type { FilePurpose, FileTarget } from "./file-delivery-contract"
import type { Actor } from "../actor"

function key() {
  const value =
    process.env.FORGE_AGENT_ARTIFACT_SECRET ||
    process.env.FORGE_AGENT_CAPABILITY_SECRET
  if (!value || value.length < 32)
    throw new Error("File grant signing is not configured.")
  return new TextEncoder().encode(value)
}
export async function mintFileGrant(
  actor: Actor,
  target: FileTarget,
  purpose: FilePurpose,
  now = new Date()
) {
  const issued = Math.floor(now.getTime() / 1000)
  return new SignJWT({
    workspaceId: actor.workspaceId,
    kind: target.kind,
    fileId: target.id,
    purpose,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(actor.userId)
    .setIssuer("forge")
    .setAudience("forge-private-file")
    .setIssuedAt(issued)
    .setExpirationTime(issued + FILE_GRANT_SECONDS)
    .sign(key())
}
export async function verifyFileGrant(
  token: string,
  actor: Actor,
  target: FileTarget,
  purpose: FilePurpose,
  now = new Date()
) {
  try {
    const { payload } = await jwtVerify(token, key(), {
      algorithms: ["HS256"],
      issuer: "forge",
      audience: "forge-private-file",
      currentDate: now,
      requiredClaims: ["sub", "iat", "exp"],
      maxTokenAge: FILE_GRANT_SECONDS,
    })
    if (
      payload.sub !== actor.userId ||
      payload.workspaceId !== actor.workspaceId ||
      payload.kind !== target.kind ||
      payload.fileId !== target.id ||
      payload.purpose !== purpose ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp - payload.iat > FILE_GRANT_SECONDS
    )
      throw new Error("Invalid grant")
  } catch {
    throw new FileDeliveryError("INVALID_FILE_GRANT")
  }
}
