/** One selection contract for startup, factories and operational identity. */
export function inspectFileStorage(env: Record<string, string | undefined>) {
  const deployed =
    env.NODE_ENV === "production" ||
    env.VERCEL === "1" ||
    Boolean(env.VERCEL_ENV) ||
    Boolean(env.FORGE_ENVIRONMENT && env.FORGE_ENVIRONMENT !== "development")
  const adapter =
    env.FORGE_AGENT_BLOB_ADAPTER || (deployed ? "vercel-private" : "local")
  const issues: Array<{ variable: string; requirement: string }> = []
  if (
    !["local", "vercel-private"].includes(adapter) ||
    (deployed && adapter === "local")
  )
    issues.push({
      variable: "FORGE_AGENT_BLOB_ADAPTER",
      requirement:
        "must select vercel-private in deployed environments; local is development only",
    })
  if (adapter === "vercel-private") {
    if (!/^store_[A-Za-z0-9]+$/.test(env.BLOB_STORE_ID ?? ""))
      issues.push({
        variable: "BLOB_STORE_ID",
        requirement: "must identify the private Blob store",
      })
    if (!env.BLOB_READ_WRITE_TOKEN?.trim())
      issues.push({
        variable: "BLOB_READ_WRITE_TOKEN",
        requirement: "is required for private file storage",
      })
    else if (
      env.BLOB_READ_WRITE_TOKEN.split("_")[3] !==
      env.BLOB_STORE_ID?.replace("store_", "")
    )
      issues.push({
        variable: "BLOB_READ_WRITE_TOKEN",
        requirement: "must belong to BLOB_STORE_ID",
      })
  }
  return { adapter: adapter as "local" | "vercel-private", issues }
}
