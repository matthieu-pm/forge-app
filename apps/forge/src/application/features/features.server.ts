import "@tanstack/react-start/server-only"
import {
  productFeatureMode,
  productFeatures,
} from "@forge/environment/product-features"
import type { ProductFeature } from "./feature-policy"
import type { Actor } from "@/application/actor"
import { ApplicationAccessError } from "@/application/authorization"

export function featureSnapshot(actor: Pick<Actor, "workspaceId">) {
  return Object.fromEntries(
    Object.keys(productFeatures).map((key) => [
      key,
      productFeatureMode(key as ProductFeature, actor.workspaceId, process.env),
    ])
  ) as Record<ProductFeature, "disabled" | "preview" | "enabled">
}

/** Actor must come from the current authenticated service boundary, never request flags. */
export function requireFeatureWrite(
  actor: Pick<Actor, "workspaceId">,
  feature: ProductFeature
) {
  if (productFeatureMode(feature, actor.workspaceId, process.env) !== "enabled")
    throw new ApplicationAccessError(
      `${productFeatures[feature].title} is unavailable in this workspace.`
    )
}
