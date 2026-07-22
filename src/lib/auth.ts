import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { electron } from "@better-auth/electron"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { db } from "@/db"
import {
  accounts,
  invitations,
  members,
  organizations,
  sessions,
  users,
  verifications,
} from "@/db/auth-schema"

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
      organization: organizations,
      member: members,
      invitation: invitations,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    electron(),
    organization({
      organizationLimit: 1,
    }),
    tanstackStartCookies(),
  ],
})
