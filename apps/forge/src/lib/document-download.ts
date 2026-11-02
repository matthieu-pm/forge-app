/** Download raw JSON as data; it is never interpreted as markup. */
export function downloadDocumentDraft(value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = "document-draft.json"
  link.click()
  URL.revokeObjectURL(url)
}
