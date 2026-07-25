import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { electron } from "@better-auth/electron"
import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { db } from "@/db"
import {
  accounts,
  apiKeys,
  invitations,
  members,
  organizations,
  sessions,
  users,
  verifications,
} from "@/db/auth-schema"
import {
  DEFAULT_API_KEY_EXPIRES_IN_DAYS,
  FORGE_API_KEY_CONFIG_ID,
  FORGE_API_KEY_PREFIX,
  MAX_API_KEY_EXPIRES_IN_DAYS,
} from "@/application/api-keys/api-key-contract"
import {
  sendVerificationEmail,
  sendWorkspaceInvitationEmail,
} from "@/application/mail/auth-emails.server"

const betterAuthUrl = process.env.BETTER_AUTH_URL
const betterAuthSecret = process.env.BETTER_AUTH_SECRET

if (!betterAuthUrl) {
  throw new Error("BETTER_AUTH_URL is required to initialize Better Auth.")
}

if (!betterAuthSecret) {
  throw new Error("BETTER_AUTH_SECRET is required to initialize Better Auth.")
}

export const auth = betterAuth({
  appName: "Forge",
  baseURL: betterAuthUrl,
  secret: betterAuthSecret,
  trustedOrigins: ["com.forge.desktop:/"],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      apikey: apiKeys,
      organization: organizations,
      member: members,
      invitation: invitations,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  emailVerification: {
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({
        email: user.email,
        name: user.name || "there",
        url,
      })
    },
  },
  user: {
    changeEmail: {
      enabled: true,
    },
  },
  plugins: [
    electron(),
    organization({
      organizationLimit: 1,
      invitationExpiresIn: 60 * 60 * 48,
      sendInvitationEmail: async (data) => {
        await sendWorkspaceInvitationEmail({
          id: data.id,
          email: data.email,
          role: data.role,
          organizationName: data.organization.name,
          inviterName: data.inviter.user.name || data.inviter.user.email,
          inviterEmail: data.inviter.user.email,
          appUrl: betterAuthUrl,
        })
      },
    }),
    apiKey({
      configId: FORGE_API_KEY_CONFIG_ID,
      references: "user",
      defaultPrefix: FORGE_API_KEY_PREFIX,
      requireName: true,
      enableMetadata: true,
      enableSessionForAPIKeys: false,
      keyExpiration: {
        defaultExpiresIn: 60 * 60 * 24 * DEFAULT_API_KEY_EXPIRES_IN_DAYS,
        minExpiresIn: 1,
        maxExpiresIn: MAX_API_KEY_EXPIRES_IN_DAYS,
      },
      rateLimit: {
        enabled: true,
        timeWindow: 60_000,
        maxRequests: 600,
      },
      permissions: {
        defaultPermissions: {
          teams: ["read"],
        },
      },
    }),
    tanstackStartCookies(),
  ],
})
