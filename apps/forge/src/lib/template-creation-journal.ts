import { applyTemplateSchema } from "./template-application-contract"
import { productStorage } from "./product-storage"
import type { ApplyTemplate } from "./template-application-contract"

export function templateCreationKey(scope: string, input: ApplyTemplate) {
  return `${scope}:commands:${input.commandKey}`
}

/** Discover immutable attempts without a mutable shared index. Include the former single-slot journal. */
export function pendingTemplateCreation(scope: string) {
  const keys = Array.from({ length: productStorage.length }, (_, index) =>
    productStorage.key(index)
  )
    .filter((key): key is string =>
      Boolean(key && (key === scope || key.startsWith(`${scope}:commands:`)))
    )
    .sort()
  for (const key of keys) {
    const raw = productStorage.getItem(key)
    if (raw === null) continue
    const input = applyTemplateSchema.parse(JSON.parse(raw))
    if (key !== scope && key !== templateCreationKey(scope, input))
      throw new Error(
        "The original template creation journal could not be verified. Its recovery record is preserved."
      )
    return { key, input }
  }
  return null
}
