import "@tanstack/react-start/server-only"
import { inspectFileStorage } from "../../../../../packages/environment/file-storage"
import { LocalFileBlobStore } from "./local-file-blob-store.server"
import { VercelPrivateFileBlobStore } from "./vercel-private-file-blob-store.server"
import type { FileBlobStore } from "@/application/files/blob-store"

export function createFileBlobStore(
  env: Record<string, string | undefined> = process.env
): FileBlobStore {
  const config = inspectFileStorage(env)
  if (config.issues.length)
    throw new Error(
      `File storage configuration is invalid: ${config.issues.map((issue) => issue.variable).join(", ")}. Values are redacted.`
    )
  return config.adapter === "vercel-private"
    ? new VercelPrivateFileBlobStore(env)
    : new LocalFileBlobStore(env.FORGE_AGENT_ARTIFACT_DIRECTORY)
}
