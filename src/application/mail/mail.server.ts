import "@tanstack/react-start/server-only"

import { Resend } from "resend"
import type { ReactNode } from "react"

type TransactionalEmail = {
  to: string
  subject: string
  text: string
  react: ReactNode
  category: "email-verification" | "workspace-invitation"
}

let resend: Resend | undefined

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
}: TransactionalEmail) {
  const { data, error } = await getResendClient().emails.send({
    from: getFromAddress(),
    to,
    subject,
    text,
    react,
    tags: [{ name: "category", value: category }],
  })

  if (error) {
    console.error("[mail] Resend rejected an email", {
      name: error.name,
      message: error.message,
    })
    throw new Error("Email delivery failed.")
  }

  return { id: data.id }
}
