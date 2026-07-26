import "@tanstack/react-start/server-only"

import { Resend } from "resend"
import type { ReactNode } from "react"

type TransactionalEmail = {
  to: string
  subject: string
  text: string
  react: ReactNode
  category: "email-verification" | "workspace-invitation"
  idempotencyKey?: string
}

let resend: Resend | undefined

export class EmailDeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly statusCode: number | null
  ) {
    super("Email delivery failed.")
    this.name = "EmailDeliveryError"
  }
}

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY?.trim()

  if (!apiKey) {
    throw new Error(
      "Email delivery is not configured. Set RESEND_API_KEY on the server."
    )
  }

  resend ??= new Resend(apiKey)
  return resend
}

function getFromAddress() {
  const configured = process.env.RESEND_FROM_EMAIL?.trim()

  if (configured) {
    return configured
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Email delivery is not configured. Set RESEND_FROM_EMAIL to a verified sender."
    )
  }

  return "Forge <onboarding@resend.dev>"
}

export async function sendTransactionalEmail({
  to,
  subject,
  text,
  react,
  category,
  idempotencyKey,
}: TransactionalEmail) {
  const message = {
    from: getFromAddress(),
    to,
    subject,
    text,
    react,
    tags: [{ name: "category", value: category }],
  }
  const result = idempotencyKey
    ? await getResendClient().emails.send(message, { idempotencyKey })
    : await getResendClient().emails.send(message)
  const { data, error } = result

  if (error) {
    console.error("[mail] Resend rejected an email", {
      name: error.name,
      statusCode: error.statusCode,
    })
    const retryable =
      error.statusCode === null ||
      error.statusCode === 408 ||
      error.statusCode === 425 ||
      error.statusCode === 429 ||
      error.statusCode >= 500 ||
      [
        "application_error",
        "internal_server_error",
        "concurrent_idempotent_requests",
      ].includes(error.name)
    throw new EmailDeliveryError(retryable, error.statusCode)
  }

  return { id: data.id }
}
