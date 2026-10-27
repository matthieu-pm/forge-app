export type SignalAccount = {
  id: string
  name: string
  provider: "PostHog" | "Amplitude"
  projects: Array<{ id: string; name: string; seed: number }>
}

// Fictional connections used only in the explicitly labeled Signals preview.
export const sampleSignalAccounts: Array<SignalAccount> = [
  {
    id: "acme-posthog",
    name: "Acme",
    provider: "PostHog",
    projects: [
      { id: "acme-product", name: "Web app", seed: 42 },
      { id: "acme-portal", name: "Customer portal", seed: 97 },
    ],
  },
  {
    id: "studio-posthog",
    name: "Studio",
    provider: "PostHog",
    projects: [{ id: "studio-product", name: "Studio app", seed: 218 }],
  },
  {
    id: "northstar-amplitude",
    name: "Northstar",
    provider: "Amplitude",
    projects: [
      { id: "northstar-product", name: "Workspace", seed: 361 },
      { id: "northstar-portal", name: "Partner portal", seed: 504 },
    ],
  },
]

export function resolveSignalScope(accountId: string, projectId?: string) {
  const account =
    sampleSignalAccounts.find((item) => item.id === accountId) ??
    sampleSignalAccounts[0]
  const project =
    account.projects.find((item) => item.id === projectId) ??
    account.projects[0]
  return { account, project }
}
