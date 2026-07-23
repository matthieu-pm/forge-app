import type { Actor } from "@/application/actor"

export type PublicApiInitialContext = {
  headers: Headers
  requestId: string
}

export type PublicApiContext = PublicApiInitialContext & {
  actor: Actor
}
