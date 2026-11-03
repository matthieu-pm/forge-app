import { createServerFn } from "@tanstack/react-start"
import { resolveDefaultHome } from "./default-home"

/** Fresh server-owned preference, feature flags and membership for every default open. */
export const loadDefaultHome = createServerFn({ method: "GET" }).handler(
  async () => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { resolveAgentFeatureFlags },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/agents/agent-feature-flags"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    let preference: unknown
    if (process.env.FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED === "true") {
      const { readAccountPreferences } =
        await import("@/application/preferences/preferences.server")
      const snapshot = await readAccountPreferences(actor)
      preference = snapshot.values["general.defaultHomeView"]
    }
    // Inbox and My issues are core routes for every verified workspace member.
    return resolveDefaultHome(preference, {
      agent: resolveAgentFeatureFlags().agent_ui,
      inbox: true,
      "my-issues": true,
    })!
  }
)
