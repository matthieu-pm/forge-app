import { z } from "zod"
import type { DBFieldAttribute, DBPrimitive } from "@better-auth/core/db"

export const usernameSchema = z
  .string()
  .trim()
  .min(1, "Username cannot be empty.")
  .max(32, "Username must be 32 characters or fewer.")
  .regex(
    /^[a-z0-9_-]+$/,
    "Username can only contain lowercase letters, numbers, underscores, and hyphens."
  )

export const profileTitleSchema = z
  .string()
  .trim()
  .max(80, "Title must be 80 characters or fewer.")

export const profileUserFields = {
  username: {
    type: "string" as const,
    required: false,
    unique: true,
    validator: { input: usernameSchema },
    transform: {
      input: (value: DBPrimitive): DBPrimitive =>
        typeof value === "string" ? value.trim().toLocaleLowerCase() : value,
    },
  },
  title: {
    type: "string" as const,
    required: false,
    validator: { input: profileTitleSchema },
    transform: {
      input: (value: DBPrimitive): DBPrimitive =>
        typeof value === "string" ? value.trim() : value,
    },
  },
} satisfies Record<string, DBFieldAttribute>
