import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"
import { createElement } from "react"

type EmailLayoutProps = {
  preview: string
  heading: string
  children?: React.ReactNode
  actionHref: string
  actionLabel: string
}

export function EmailLayout({
  preview,
  heading,
  children,
  actionHref,
  actionLabel,
}: EmailLayoutProps) {
  return createElement(
    Html,
    { lang: "en" },
    createElement(Head),
    createElement(Preview, null, preview),
    createElement(
      Body,
      { style: body },
      createElement(
        Container,
        { style: container },
        createElement(
          Section,
          { style: brand },
          createElement(Text, { style: brandName }, "Forge")
        ),
        createElement(Heading, { style: headingStyle }, heading),
        createElement(Section, { style: content }, children),
        createElement(
          Section,
          { style: action },
          createElement(
            Button,
            { href: actionHref, style: button },
            actionLabel
          )
        ),
        createElement(Hr, { style: rule }),
        createElement(
          Text,
          { style: footer },
          "If you weren't expecting this email, you can safely ignore it."
        )
      )
    )
  )
}

const body = {
  backgroundColor: "#f6f7f9",
  color: "#18181b",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  margin: 0,
  padding: "40px 16px",
}

const container = {
  backgroundColor: "#ffffff",
  border: "1px solid #e4e4e7",
  borderRadius: "16px",
  margin: "0 auto",
  maxWidth: "560px",
  padding: "32px",
}

const brand = {
  marginBottom: "28px",
}

const brandName = {
  color: "#18181b",
  fontSize: "18px",
  fontWeight: "700",
  letterSpacing: "-0.02em",
  margin: 0,
}

const headingStyle = {
  color: "#18181b",
  fontSize: "24px",
  fontWeight: "650",
  letterSpacing: "-0.03em",
  lineHeight: "1.25",
  margin: "0 0 16px",
}

const content = {
  color: "#52525b",
  fontSize: "15px",
  lineHeight: "24px",
}

const action = {
  margin: "28px 0",
}

const button = {
  backgroundColor: "#18181b",
  borderRadius: "10px",
  color: "#ffffff",
  display: "inline-block",
  fontSize: "14px",
  fontWeight: "600",
  padding: "12px 18px",
  textDecoration: "none",
}

const rule = {
  borderColor: "#e4e4e7",
  margin: "28px 0 20px",
}

const footer = {
  color: "#71717a",
  fontSize: "12px",
  lineHeight: "18px",
  margin: 0,
}
