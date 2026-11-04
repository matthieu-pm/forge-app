export function isPreferenceImportSourceKey(key: string) {
  return (
    key === "forge.personal-preferences" ||
    key.startsWith("forge.personal-preferences.recovery.") ||
    /^forge:(calls-and-transcripts|notifications):v\d+:/.test(key)
  )
}
