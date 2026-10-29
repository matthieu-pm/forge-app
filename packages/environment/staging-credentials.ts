// Credential fingerprints only. Raw staging secrets live in Vercel sensitive env vars.
// Rotate by registering the new staging-only credential here before deploying it.
export const STAGING_CREDENTIAL_DIGESTS: Readonly<Record<string, string>> = {
  OPENAI_API_KEY:
    "44059449a1a560c3c7c488d721a19fdd082b02c59080e67698fa0de1a76a0390",
  RESEND_API_KEY:
    "733fb090bac29ec6b5e84a554fc2ddc0188bcdd2efdd12e333de1a9283f12290",
  POLAR_ACCESS_TOKEN:
    "5ccdef522d20813011236f8d44601f5ade4199cb7acb117090ec94618bc14456",
  FORGE_GOOGLE_MEET_CLIENT_ID:
    "cecae28260f12f758f2c0f69d9ad3ba028b2d4584552ec97e06a72f70ba3061e",
  FORGE_GOOGLE_MEET_CLIENT_SECRET:
    "0166583bb9d14140d3174850f7dc1321d2142a4e0eb0237b3aab8d9b5095518f",
  FORGE_ZOOM_CLIENT_ID:
    "022a314179a31794a53870acbee5beb52dea559a21041ecd20866ca506b65227",
  FORGE_ZOOM_CLIENT_SECRET:
    "d28fbe332199678403a10de66305df201bdec4cd106fa1d83d6ceebb6e6d58d7",
} as const

export const STAGING_INTEGRATIONS = {
  openaiProjectId: "proj_c3eIcqr18kXfMsE5E2U48owD",
  openaiModel: "gpt-5.6-luna",
  resendKeyId: "0c1fa4fe-0e5b-454c-a8f8-fbfbfe91f692",
  resendDomainId: "805034fc-009f-468f-af8c-1719fe0cd3e2",
  mailFrom: "Forge staging <staging@nexstudio.io>",
  mailRecipients: [
    "delivered@resend.dev",
    "bounced@resend.dev",
    "complained@resend.dev",
  ],
  polarOrganizationId: "0d79d64a-419b-490a-ad9f-271a6fce1fc5",
  zoomApplicationId: "0DLzA3R7TVurM0-JX_G5Og",
  zoomClientId: "8E8Fr71StSxLu1C0y6wdQ",
  googleProjectId: "arctic-conduit-513113-k3",
  googleClientId:
    "761176153286-nf4hqp7ur24q6ebohnhf57k0vj1klg2b.apps.googleusercontent.com",
  meetingRedirectUri:
    "https://forge-staging-matthieu-pm.vercel.app/api/calls/oauth/callback",
} as const
