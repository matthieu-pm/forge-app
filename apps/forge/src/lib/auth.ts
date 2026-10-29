import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { electron } from "@better-auth/electron"
import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import {
  desktopAuthScheme,
  developmentDesktopAuthScheme,
} from "../../electron/shared/desktop-auth-protocol"
import { db } from "@/db"
import * as authSchema from "@/db/auth-schema"
import {
  DEFAULT_API_KEY_EXPIRES_IN_DAYS,
  FORGE_API_KEY_CONFIG_ID,
  FORGE_API_KEY_PREFIX,
  MAX_API_KEY_EXPIRES_IN_DAYS,
} from "@/application/api-keys/api-key-contract"
import { profileUserFields } from "@/lib/profile-fields"
import { isInvitationWorkflowEnabled } from "@/application/workflows/workflow-feature-flags.server"
import {
  sendVerificationEmail,
  sendWorkspaceInvitationEmail,
} from "@/application/mail/auth-emails.server"

import { chatGPTAuth } from "@/lib/chatgpt-auth.server"
import {
  withMemberCapacityErrors,
  workspaceAuthMembershipLimit,
} from "@/application/billing/member-capacity-auth.server"
import { resolveAuthUrl } from "@/lib/auth-url"

const betterAuthUrl = resolveAuthUrl(process.env)
const betterAuthSecret = process.env.BETTER_AUTH_SECRET

if (!betterAuthUrl) {
  throw new Error("BETTER_AUTH_URL is required to initialize Better Auth.")
}

if (!betterAuthSecret) {
  throw new Error("BETTER_AUTH_SECRET is required to initialize Better Auth.")
}

function authDatabaseAdapter(database: Parameters<typeof drizzleAdapter>[0]) {
  return withMemberCapacityErrors(
    drizzleAdapter(database, {
      provider: "pg",
      transaction: true,
      schema: {
        ...authSchema,
        user: authSchema.users,
        session: authSchema.sessions,
        account: authSchema.accounts,
        verification: authSchema.verifications,
        apikey: authSchema.apiKeys,
        organization: authSchema.organizations,
        member: authSchema.members,
        invitation: authSchema.invitations,
      },
    })
  )
}

export const auth = betterAuth({
  appName: "Forge",
  baseURL: betterAuthUrl,
  secret: betterAuthSecret,
  // Keep session validation database-backed, but fetch its user in the same query.
  experimental: { joins: true },
  trustedOrigins: [
    `${desktopAuthScheme}:/`,
    `${developmentDesktopAuthScheme}:/`,
  ],
  database: authDatabaseAdapter(db),
  account: { accountLinking: { enabled: true, disableImplicitLinking: true } },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  user: {
    additionalFields: profileUserFields,
    changeEmail: {
      enabled: true,
    },
  },
  session: {
    updateAge: 60,
    deferSessionRefresh: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({
        email: user.email,
        name: user.name || "there",
        url,
      })
    },
  },
  plugins: [
    electron(),
    chatGPTAuth(),
    organization({
      membershipLimit: (_user, workspace) =>
        workspaceAuthMembershipLimit(workspace.id),
      requireEmailVerificationOnInvitation: true,
      allowUserToCreateOrganization: (user) => user.emailVerified === true,
      invitationExpiresIn: 60 * 60 * 48,
      sendInvitationEmail: async (data) => {
        if (isInvitationWorkflowEnabled(data.organization.id)) {
          return
        }

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

class RollbackAuthResponse extends Error {
  constructor(readonly response: Response) {
    super("Rollback the unsuccessful auth operation.")
  }
}

/**
 * Better Auth updates an invitation before its inner member transaction. Scope
 * the WHOLE endpoint to one transaction so losing the last slot cannot consume
 * the invitation or commit partial membership/team/session state.
 */
export async function handleAuthRequest(request: Request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "")
  if (
    request.method !== "POST" ||
    path !== "/api/auth/organization/accept-invitation"
  )
    return auth.handler(request)
  try {
    return await db.transaction(async (transaction) => {
      const scoped = betterAuth({
        ...auth.options,
        // Keep the SDK's inner member transaction as a savepoint: its failure
        // handler restores the invitation and must not query an aborted outer
        // transaction. The outer transaction still covers the whole endpoint.
        database: authDatabaseAdapter(transaction),
      })
      const response = await scoped.handler(request)
      if (!response.ok) throw new RollbackAuthResponse(response)
      return response
    })
  } catch (error) {
    if (error instanceof RollbackAuthResponse) return error.response
    throw error
  }
}
