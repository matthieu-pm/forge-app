import { z } from "zod"

export const publicApiErrors = {
  BAD_REQUEST: {
    status: 400,
    message: "The request is invalid.",
  },
  UNAUTHORIZED: {
    status: 401,
    message: "A valid Forge API key is required.",
  },
  FORBIDDEN: {
    status: 403,
    message: "The credential cannot perform this operation.",
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested resource was not found.",
  },
  CONFLICT: {
    status: 409,
    message: "The request conflicts with an existing resource.",
    data: z.object({
      reason: z.enum([
        "SLUG_TAKEN",
        "TEAM_LIMIT",
        "IDENTIFIER_TAKEN",
        "IDEMPOTENCY_KEY_REUSED",
      ]),
      field: z.enum(["name", "identifier"]).optional(),
    }),
  },
  RATE_LIMITED: {
    status: 429,
    message: "The API key rate limit has been exceeded.",
  },
} as const
