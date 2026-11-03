import { createHash } from "node:crypto"
import { productFeatureMode } from "@forge/environment/product-features"

/** A different immutable deployment cannot assert what happened in its predecessor. */
export function slaGate(workspaceId: string) {
  const enabled =
    productFeatureMode("sla", workspaceId, process.env) === "enabled"
  return {
    enabled,
    identity: createHash("sha256")
      .update(
        JSON.stringify({
          deployment:
            process.env.VERCEL_DEPLOYMENT_ID ??
            process.env.FORGE_SOURCE_REVISION ??
            "local",
          workspaceId,
          enabled,
        })
      )
      .digest("hex"),
  }
}
