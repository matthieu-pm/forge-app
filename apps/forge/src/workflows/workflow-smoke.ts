import { smokeStep } from "@/workflows/workflow-smoke-step"

export async function workflowSmoke(correlationId: string) {
  "use workflow"

  return smokeStep(correlationId)
}
