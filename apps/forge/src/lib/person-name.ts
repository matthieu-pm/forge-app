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

function uniquePrefixes(values: ReadonlyArray<string>) {
  const sorted = [...new Set(values)].sort()
  const sharedLength = (first: string, second = "") => {
    let length = 0
    while (length < first.length && first[length] === second[length]) length++
    return length
  }
  return new Map(
    sorted.map((value, index) => [
      value,
      value.slice(
        0,
        Math.max(
          6,
          sharedLength(value, sorted[index - 1]) + 1,
          sharedLength(value, sorted[index + 1]) + 1
        )
      ),
    ])
  )
}

const encodedId = (id: string) =>
  Array.from(id, (character) =>
    character.codePointAt(0)!.toString(16).padStart(6, "0")
  ).join("")

export function formatPersonNames(
  people: ReadonlyArray<PersonIdentity>,
  format: NameFormat
) {
  const directory = new Map(people.map((person) => [personId(person), person]))
  const groups = new Map<
    string,
    { count: number; usernames: Map<string, number> }
  >()
  const idCounts = new Map<string, number>()
  for (const person of directory.values()) {
    const name = key(baseName(person, format))
    const group = groups.get(name) ?? {
      count: 0,
      usernames: new Map<string, number>(),
    }
    const username = key(clean(person.username))
    group.count++
    group.usernames.set(username, (group.usernames.get(username) ?? 0) + 1)
    groups.set(name, group)
    const id = key(personId(person))
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  const prefixes = uniquePrefixes([...directory.keys()].map(key))
  const encodedPrefixes = uniquePrefixes([...directory.keys()].map(encodedId))
  const suffix = (id: string) => {
    const normalized = key(id)
    const prefix = prefixes.get(normalized)!
    return idCounts.get(normalized)! > 1
      ? `${prefix}~${encodedPrefixes.get(encodedId(id))!}`
      : prefix
  }
  const labels = new Map<string, string>()
  for (const [id, person] of directory) {
    const name = baseName(person, format)
    let label = name
    const collisions = groups.get(key(name))!
    if (clean(person.name) || clean(person.username)) {
      if (collisions.count === 1) {
        labels.set(id, name)
        continue
      }
      const username = clean(person.username)
      if (username && key(username) !== key(name)) {
        label = `${name} · @${username.replace(/^@/, "")}`
        if (collisions.usernames.get(key(username)) === 1) {
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
