export async function copyTextToClipboard(value: string) {
  if (window.forgeDesktop?.copyText) {
    await window.forgeDesktop.copyText(value)
    return
  }

  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    // Electron can expose the web Clipboard API while denying clipboard-write.
  }

  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.readOnly = true
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  document.body.append(textarea)
  textarea.select()

  try {
    if (!document.execCommand("copy")) {
      throw new Error("The clipboard rejected the copy operation.")
    }
  } finally {
    textarea.remove()
  }
}
