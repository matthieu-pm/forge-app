export async function prepareEmojiImage(file: File): Promise<string> {
  if (
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)
  ) {
    throw new Error("Choose a PNG, JPG, GIF, or WebP image.")
  }
  if (file.size > 2 * 1024 * 1024)
    throw new Error("Choose an image smaller than 2 MB.")
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error("Empty image")
    const scale = Math.min(
      1,
      128 / Math.max(image.naturalWidth, image.naturalHeight)
    )
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Image conversion unavailable")
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/png")
  } catch {
    throw new Error("This image could not be read. Choose another file.")
  } finally {
    URL.revokeObjectURL(url)
  }
}
