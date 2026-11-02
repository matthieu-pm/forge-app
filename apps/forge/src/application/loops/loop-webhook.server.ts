import "@tanstack/react-start/server-only"
import { timingSafeEqual } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { LoopPolicyError, loopsEnabled } from "./loop-access.server"
import { enqueueLoopRun, webhookHash } from "./loops.server"
import { db, teamLoops, workspaceSecuritySettings } from "@/db"

const response = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
export async function handleLoopWebhook(request: Request, loopId: string) {
  if (request.method !== "POST")
    return response({ error: "Method not allowed" }, 405)
  if (!loopsEnabled() || !z.uuid().safeParse(loopId).success)
    return response({ error: "Webhook unavailable" }, 404)
  const token = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)?.[1]
  const key = request.headers.get("Webhook-Id")?.trim()
  if (!token) return response({ error: "Webhook unavailable" }, 404)
  if (!key || key.length > 200)
    return response({ error: "A unique Webhook-Id is required" }, 400)
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return response({ error: "JSON required" }, 415)
  if (Number(request.headers.get("Content-Length")) > 131072)
    return response({ error: "Payload too large" }, 413)
  let bytes = 0,
    text = ""
  try {
    const reader = request.body?.getReader()
    if (!reader) return response({ error: "JSON required" }, 400)
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 131072) {
        await reader.cancel()
        return response({ error: "Payload too large" }, 413)
      }
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
    const body = JSON.parse(text, (_key, value) => {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new SyntaxError("JSON numbers must be finite.")
      return value
    })
    const result = await db.transaction(async (tx) => {
      const row = (
        await tx
          .select()
          .from(teamLoops)
          .where(
            and(
              eq(teamLoops.id, loopId),
              eq(teamLoops.enabled, true),
              isNull(teamLoops.deletedAt)
            )
          )
          .for("share")
      )[0]
      const actual = webhookHash(token),
        expected = row?.webhookSecretHash ?? "0".repeat(64)
      if (
        !timingSafeEqual(Buffer.from(actual), Buffer.from(expected)) ||
        !row ||
        row.fields.trigger.kind !== "webhook"
      )
        return null
      const security = (
        await tx
          .select({
            external: workspaceSecuritySettings.externalLoopSourcesEnabled,
          })
          .from(workspaceSecuritySettings)
          .where(eq(workspaceSecuritySettings.workspaceId, row.workspaceId))
          .for("share")
      )[0]
      // The workspace default denies external sources, including incoming
      // webhooks. Recheck on every receipt, not just when issuing a secret.
      if (!security?.external) return null
      return enqueueLoopRun(
        tx,
        row,
        `webhook:${expected.slice(0, 16)}:${key}`,
        { kind: "webhook", payload: body }
      )
    })
    return result
      ? response({ accepted: true, runId: result.id }, 202)
      : response({ error: "Webhook unavailable" }, 404)
  } catch (error) {
    return response(
      {
        error:
          error instanceof SyntaxError
            ? "Invalid JSON"
            : error instanceof LoopPolicyError
              ? "Event identity already used with different input"
              : "Webhook receipt could not be confirmed. Retry with the same Webhook-Id.",
      },
      error instanceof SyntaxError
        ? 400
        : error instanceof LoopPolicyError
          ? 409
          : 503
    )
  }
}
