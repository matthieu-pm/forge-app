export async function smokeStep(correlationId: string) {
  "use step"

  return { correlationId, state: "ok" as const }
}
