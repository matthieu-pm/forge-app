import type { PersonalPreferences } from "./personal-preference-contract"

export type PersonIdentity = {
  id?: string
  userId?: string
  name?: string | null
  username?: string | null
}
export type NameFormat = PersonalPreferences["displayNames"]
export const personId = (person: PersonIdentity) =>
  person.userId ?? person.id ?? ""
const clean = (value?: string | null) => value?.trim() ?? ""
const key = (value: string) => value.normalize("NFKC").toLowerCase()
export const personSearchText = (person: PersonIdentity) =>
  `${clean(person.name)} ${clean(person.username)}`

function baseName(person: PersonIdentity, format: NameFormat) {
  const name = clean(person.name),
    username = clean(person.username)
  return (
    (format === "username" ? username || name : name || username) || "Member"
  )
}

export function formatPersonNames(
  people: ReadonlyArray<PersonIdentity>,
  format: NameFormat
) {
  const directory = new Map(people.map((person) => [personId(person), person]))
  const groups = new Map<string, Array<PersonIdentity>>()
  for (const person of directory.values()) {
    const name = key(baseName(person, format))
    groups.set(name, [...(groups.get(name) ?? []), person])
  }
  const suffix = (id: string) => {
    let length = Math.min(6, id.length)
    while (
      length < id.length &&
      [...directory.keys()].some(
        (other) =>
          other !== id && other.slice(0, length) === id.slice(0, length)
      )
    )
      length++
    return id.slice(0, length)
  }
  const labels = new Map<string, string>()
  for (const [id, person] of directory) {
    const name = baseName(person, format)
    let label = name
    const collisions = groups.get(key(name))!
    if (clean(person.name) || clean(person.username)) {
      if (collisions.length === 1) {
        labels.set(id, name)
        continue
      }
      const username = clean(person.username)
      if (username && key(username) !== key(name)) {
        label = `${name} · @${username.replace(/^@/, "")}`
        if (
          collisions.filter(
            (entry) => key(clean(entry.username)) === key(username)
          ).length === 1
        ) {
          labels.set(id, label)
          continue
        }
      }
    }
    labels.set(id, id ? `${label} · ${suffix(id)}` : label)
  }
  // A real full name can equal another account's generated collision label.
  for (let pass = 0; pass < directory.size; pass++) {
    const counts = new Map<string, number>()
    for (const label of labels.values())
      counts.set(key(label), (counts.get(key(label)) ?? 0) + 1)
    let changed = false
    for (const [id, label] of labels) {
      if (id && counts.get(key(label))! > 1) {
        labels.set(id, `${label} · ${suffix(id)}`)
        changed = true
      }
    }
    if (!changed) break
  }
  return labels
}

export function formatPersonName(
  person: PersonIdentity,
  format: NameFormat,
  people: ReadonlyArray<PersonIdentity> = []
): string {
  return formatPersonNames([...people, person], format).get(personId(person))!
}

export function resolvePerson<T extends PersonIdentity>(
  people: ReadonlyArray<T>,
  value: string
) {
  const exact = people.find((person) => personId(person) === value)
  if (exact) return exact
  const legacy = people.filter((person) => person.name === value)
  return legacy.length === 1 ? legacy[0] : undefined
}
