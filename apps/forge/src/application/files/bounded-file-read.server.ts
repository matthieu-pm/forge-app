import "@tanstack/react-start/server-only"

/** Stop upstream reads at the bound; do not buffer an arbitrary storage response. */
export async function readBoundedFile(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 100_000_000)
    throw new Error("Invalid file read bound.")
  const reader = stream.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener("abort", abort, { once: true })
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    signal?.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error("File exceeds its read bound.")
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    signal?.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
