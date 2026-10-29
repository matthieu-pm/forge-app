/** Private byte storage shared by agent, issue and document files.
 * References are internal opaque keys, never public URLs or authorization grants.
 * Implementations must reject overwrite and never fall back to another store.
 */
export interface FileBlobStore {
  put: (reference: string, content: Uint8Array) => Promise<void>
  get: (reference: string) => Promise<Uint8Array | null>
  delete: (reference: string) => Promise<void>
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
// Legacy references remain readable for migration; new files use files/<random UUID>.
const referencePattern = new RegExp(
  `^(?:files/${uuid}|attachments/${uuid}|${uuid}/${uuid})$`
)
export function assertFileReference(reference: string) {
  if (!referencePattern.test(reference))
    throw new Error("Invalid file storage reference.")
}
