import "@tanstack/react-start/server-only"

import { createHmac } from "node:crypto"

import { CompactSign, compactVerify } from "jose"
import { z } from "zod"

const payloadSchema = z
  .object({
    generation: z.number().int().positive(),
    workspaceId: z.string().min(1),
  })
  .strict()

function signingKey() {
  const rootSecret =
    process.env.FORGE_INVITE_LINK_SECRET ?? process.env.BETTER_AUTH_SECRET
  if (!rootSecret || rootSecret.length < 32) {
    throw new Error(
      "FORGE_INVITE_LINK_SECRET or BETTER_AUTH_SECRET must contain at least 32 characters."
    )
  }

  return createHmac("sha256", rootSecret)
    .update("forge-workspace-invite-link:v1")
    .digest()
}

export async function signWorkspaceInviteLink(input: {
  generation: number
  workspaceId: string
}) {
  const payload = new TextEncoder().encode(
    JSON.stringify(payloadSchema.parse(input))
  )

  return new CompactSign(payload)
    .setProtectedHeader({ alg: "HS256", typ: "forge-workspace-invite" })
    .sign(signingKey())
}

export async function verifyWorkspaceInviteLink(token: string) {
  const result = await compactVerify(token, signingKey(), {
    algorithms: ["HS256"],
  })
  const header = result.protectedHeader
  if (header.typ !== "forge-workspace-invite") {
    throw new Error("The invite link type is invalid.")
  }

  return payloadSchema.parse(
    JSON.parse(new TextDecoder().decode(result.payload))
  )
}
