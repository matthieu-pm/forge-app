import { initiativeChangesSchema } from "@/lib/shared-initiative-contract"
import {
  initiativeCommandPrefix,
  sharedInitiativesKey,
} from "@/lib/shared-initiative-key"
import { initiativeStoreSchema } from "@/lib/initiatives"
import { productStorage } from "@/lib/product-storage"
import { Button } from "@/components/ui/button"

export function InitiativeDraftRecovery({
  drafts,
  workspaceId,
  pending,
}: {
  drafts: Array<{ key: string; recovery: boolean; value: string }>
  workspaceId: string
  pending: boolean
}) {
  const current = initiativeStoreSchema.safeParse(
    JSON.parse(
      productStorage.getItem(sharedInitiativesKey(workspaceId)) ?? "null"
    )
  )
  return drafts.map((draft) => {
    const parsed = initiativeChangesSchema.safeParse(JSON.parse(draft.value))
    if (!parsed.success) return null
    const changes = parsed.data
    return (
      <details key={draft.key} className="mt-2">
        <summary>
          {draft.recovery
            ? "Saved initiative draft"
            : "Pending initiative changes"}
        </summary>
        {changes.map((c) => (
          <div key={c.id} className="my-2">
            <p className="font-medium">
              {c.changes.name ??
                current.data?.initiatives.find((i) => i.id === c.id)?.name ??
                "Initiative draft"}
            </p>
            {Object.entries(c.changes).map(([field, value]) => (
              <p key={field}>
                {field}:{" "}
                {field === "updates" || field === "comments"
                  ? (value as Array<{ text: string }>)
                      .map((e) => e.text)
                      .join(" · ")
                  : field === "description" || field === "icon"
                    ? "Edited"
                    : String(value)}
              </p>
            ))}
            <p>
              {c.addProjectIds.length} project links added ·{" "}
              {c.removeProjectIds.length} removed
            </p>
          </div>
        ))}
        {draft.recovery ? (
          <>
            <p>
              Review the latest shared initiative before applying this draft.
            </p>
            <Button
              size="sm"
              disabled={pending || !current.success}
              onClick={() => {
                if (!current.success) return
                const rebased = changes.map((c) => ({
                  ...c,
                  expectedRevision:
                    current.data.initiatives.find((i) => i.id === c.id)
                      ?.revision ?? null,
                }))
                productStorage.setItem(
                  `${initiativeCommandPrefix}${crypto.randomUUID()}`,
                  JSON.stringify(rebased)
                )
              }}
            >
              Apply draft to latest initiative
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => productStorage.removeItem(draft.key)}
            >
              Discard saved initiative draft
            </Button>
          </>
        ) : (
          <p>
            Retry sends this exact draft. Keep a server copy and load latest
            preserves it privately for review.
          </p>
        )}
      </details>
    )
  })
}
