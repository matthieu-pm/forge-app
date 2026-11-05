import type { ProductStateCommand } from "@/lib/product-state-contract"

export const entries = () =>
  JSON.parse(localStorage.getItem("for68-fixture-journal") ?? "[]") as Array<{
    key: string
    value: string | null
    revision: number
  }>
export async function loadProductState() {
  return {
    workspaceId: "fixture",
    userId: "fixture-owner",
    sessionId: "fixture",
    entries: entries(),
  }
}
export async function persistProductState({
  data,
}: {
  data: ProductStateCommand
}) {
  const revision = data.expectedRevision + 1
  localStorage.setItem(
    "for68-fixture-journal",
    JSON.stringify([
      ...entries().filter((entry) => entry.key !== data.key),
      { key: data.key, value: data.value, revision },
    ])
  )
  return { replayed: false, value: { revision } }
}
