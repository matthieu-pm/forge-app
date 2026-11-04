export const identity = {
  userId: "alice",
  sessionId: "fixture",
  workspaceId: "fixture",
}
export const useProtectedIdentity = () => identity
export const useFeatureMode = () => "enabled"
export const useAccountPreferences = () => ({
  editable: true,
  pending: false,
  client: {
    identity,
    getSnapshot: () => ({ pending: false }),
    refresh: () => Promise.resolve(),
  },
})
