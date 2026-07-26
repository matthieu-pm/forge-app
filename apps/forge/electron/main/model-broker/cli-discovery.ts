import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { delimiter, dirname, isAbsolute, join } from "node:path"

export type DiscoveredCli = {
  id: "codex"
  executablePath: string
}

export function candidateExecutablePaths(
  command: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  const pathEntries = (environment.PATH ?? "")
    .split(delimiter)
    .filter(isAbsolute)
  const home = environment.USERPROFILE ?? environment.HOME
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...(home
      ? [
          join(home, ".local", "bin"),
          join(home, ".bun", "bin"),
          join(home, ".npm-global", "bin"),
        ]
      : []),
    ...pathEntries,
  ].map((directory) => join(directory, command))
}

export async function validateTrustedExecutable(candidate: string) {
  try {
    const resolved = await realpath(candidate)
    const metadata = await stat(resolved)
    if (!metadata.isFile() || (metadata.mode & 0o022) !== 0) return null
    const currentUserId =
      typeof process.getuid === "function" ? process.getuid() : null
    if (
      currentUserId !== null &&
      metadata.uid !== 0 &&
      metadata.uid !== currentUserId
    ) {
      return null
    }
    await access(resolved, constants.X_OK)
    return resolved
  } catch {
    return null
  }
}

export async function discoverCodexCli(): Promise<DiscoveredCli | null> {
  for (const candidate of new Set(candidateExecutablePaths("codex"))) {
    const executablePath = await validateTrustedExecutable(candidate)
    if (executablePath) return { id: "codex", executablePath }
  }
  return null
}

export function sanitizedProcessEnvironment(executablePath: string) {
  const environment: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL,
    PATH: [
      dirname(executablePath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(delimiter),
    TMPDIR: process.env.TMPDIR,
  }
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
}
