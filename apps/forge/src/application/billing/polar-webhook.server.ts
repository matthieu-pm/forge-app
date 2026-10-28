import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { webhooks } from "@polar-sh/sdk/2026-10"
import { z } from "zod"
import { PolarSubscriptionReconciler } from "./polar-subscription-reconciliation.server"
import type { BillingConfig } from "./billing-config.server"

const MAX_BODY_BYTES = 1_048_576
const identitySchema = z.object({
  type: z.enum([
    "subscription.active",
    "subscription.past_due",
    "subscription.updated",
    "subscription.canceled",
    "subscription.uncanceled",
  ]),
  data: z.object({
    id: z.uuid(),
    customer: z.object({ external_id: z.string().min(1).max(255) }),
  }),
})

function response(status: number, code: string) {
  return Response.json(
    { code },
    { status, headers: { "cache-control": "no-store" } }
  )
}

export async function handlePolarWebhook(
  request: Request,
  config: BillingConfig,
  reconciler?: Pick<PolarSubscriptionReconciler, "reconcile">
) {
  if (!config.enabled) return response(404, "NOT_FOUND")
  if (request.method !== "POST") return response(405, "METHOD_NOT_ALLOWED")
  const reader = request.body?.getReader()
  if (!reader) return response(400, "INVALID_WEBHOOK")
  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        return response(413, "WEBHOOK_TOO_LARGE")
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const raw = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    raw.set(chunk, offset)
    offset += chunk.byteLength
  }
  let event: unknown
  try {
    event = await webhooks.validateEvent(
      raw,
      {
        "webhook-id": request.headers.get("webhook-id") ?? "",
        "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
        "webhook-signature": request.headers.get("webhook-signature") ?? "",
      },
      config.webhookSecret
    )
  } catch {
    return response(400, "INVALID_WEBHOOK")
  }
  // SDK verification authenticates bytes/type; validate the identity shape too.
  const parsed = identitySchema.safeParse(event)
  if (!parsed.success) return response(503, "BILLING_EVENT_POLICY_REQUIRED")
  const prefix = "forge:workspace:"
  const customer = parsed.data.data.customer.external_id
  if (!customer.startsWith(prefix) || !customer.slice(prefix.length).trim())
    return response(400, "INVALID_BILLING_IDENTITY")
  try {
    await (reconciler ?? new PolarSubscriptionReconciler(config)).reconcile({
      workspaceId: customer.slice(prefix.length),
      subscriptionId: parsed.data.data.id,
      eventId: request.headers.get("webhook-id")!,
      bodyHash: createHash("sha256").update(raw).digest("hex"),
    })
    return response(200, "RECONCILED")
  } catch {
    // No raw body, customer fields, provider errors or credentials in responses.
    return response(503, "BILLING_RECONCILIATION_REQUIRED")
  }
}
