import type { RoutingInput } from "@/application/agents/model-router"
import { resolveModel } from "@/application/agents/model-router"

/** Loop model selection stays on Auto, but its published reasoning is an
 * explicit control. Reuse manual effort validation without changing the
 * routing behavior of personal Auto conversations. */
export async function resolveLoopModel(input: RoutingInput) {
  const availableModels = input.availableModels.filter(
    (model) =>
      model.locality === "server-capable" &&
      model.executionKind === "forge-native"
  )
  const selected = await resolveModel({
    ...input,
    mode: "auto",
    availableModels,
  })
  if (input.reasoningEffort === undefined) return selected
  const explicit = await resolveModel({
    ...input,
    availableModels,
    mode: "manual",
    manualModel: selected.model,
  })
  return {
    ...explicit,
    requestedSelection: selected.requestedSelection,
    routingPolicyVersion: selected.routingPolicyVersion,
    routingReason: selected.routingReason,
  }
}
