import { productStorage } from "@/lib/product-storage"

export type LocalProfile = {
  title: string
  username: string
}

export function profileStorageKey(userId: string) {
  return `forge:profile:${userId}`
}

export function usernameFromEmail(email: string) {
  return (
    email
      .split("@", 1)[0]
      ?.toLocaleLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 32) ?? ""
  )
}

export function readLocalProfile(userId: string, email: string): LocalProfile {
  const fallbackProfile: LocalProfile = {
    title: "",
    username: usernameFromEmail(email),
  }

  try {
    const stored = productStorage.getItem(profileStorageKey(userId))
    return stored
      ? ({ ...fallbackProfile, ...JSON.parse(stored) } as LocalProfile)
      : fallbackProfile
  } catch {
    return fallbackProfile
  }
}

export function writeLocalProfile(userId: string, profile: LocalProfile) {
  productStorage.setItem(profileStorageKey(userId), JSON.stringify(profile))
}
