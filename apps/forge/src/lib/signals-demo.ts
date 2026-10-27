export type SignalMetric = "users" | "sessions" | "interactions" | "returning"
export type SignalDimension =
  | "features"
  | "pages"
  | "events"
  | "sources"
  | "devices"
  | "browsers"
  | "countries"
export type SignalFilters = { device?: string; plan?: string; feature?: string }
export type SignalSession = {
  day: number
  user: number
  firstDay: number
  device: string
  browser: string
  country: string
  source: string
  plan: string
  features: Array<string>
  pages: Array<string>
}
export type SignalBreakdown = { name: string; count: number; share: number }
export const signalDemoEnd = Date.UTC(2026, 9, 26)
const dayMs = 86_400_000
const featureNames = [
  "Search",
  "Boards",
  "Reports",
  "Comments",
  "Integrations",
  "Exports",
  "Automations",
  "Sharing",
]
const featureEvents: Record<string, string> = {
  Search: "search_performed",
  Boards: "board_opened",
  Reports: "report_viewed",
  Comments: "comment_added",
  Integrations: "integration_used",
  Exports: "export_created",
  Automations: "automation_run",
  Sharing: "link_shared",
}
const featurePages: Record<string, string> = {
  Search: "/search",
  Boards: "/boards",
  Reports: "/reports",
  Comments: "/activity",
  Integrations: "/integrations",
  Exports: "/reports/export",
  Automations: "/automations",
  Sharing: "/shared",
}

// Fictional product history: persistent user cohorts, a launch campaign, a reporting
// cycle, and an automation release. All dashboard metrics use these same sessions.
export function createDemoSessions(initialSeed = 42): Array<SignalSession> {
  let seed = initialSeed
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  function pick<T>(options: Array<[T, number]>): T {
    let roll = random() * options.reduce((sum, [, weight]) => sum + weight, 0)
    for (const [value, weight] of options) {
      roll -= weight
      if (roll < 0) return value
    }
    return options[options.length - 1][0]
  }
  type DemoPerson = {
    id: number
    joined: number
    lifetime: number
    plan: string
    persona: string
    device: string
    browser: string
    country: string
    source: string
    interests: Set<string>
    engagement: number
  }
  const people: Array<DemoPerson> = []
  const firstSeen = new Map<number, number>()
  const sessions: Array<SignalSession> = []
  const weekdays = [0.13, 1.08, 1.02, 0.94, 1.12, 0.76, 0.19]

  function addPerson(day: number, campaign: boolean) {
    const plan = pick([
      ["Free", campaign ? 90 : 63],
      ["Pro", 29],
      ["Enterprise", 8],
    ])
    const persona = pick([
      ["Collaborator", 53],
      ["Analyst", plan === "Free" ? 8 : 26],
      ["Builder", plan === "Free" ? 6 : 19],
      ["Explorer", campaign ? 48 : 23],
    ])
    const device = pick([
      ["Desktop", persona === "Explorer" ? 55 : 86],
      ["Mobile", 18],
      ["Tablet", 2],
    ])
    const interests = new Set<string>()
    const affinity: Record<string, number> = {
      Boards: persona === "Explorer" ? 0.42 : 0.92,
      Search: 0.68,
      Comments: persona === "Collaborator" ? 0.7 : 0.12,
      Reports: persona === "Analyst" ? 0.94 : 0.07,
      Integrations: persona === "Builder" ? 0.76 : 0.025,
      Exports: persona === "Analyst" && plan !== "Free" ? 0.56 : 0.015,
      Automations: persona === "Builder" && plan !== "Free" ? 0.86 : 0.005,
      Sharing: persona === "Collaborator" ? 0.38 : 0.06,
    }
    for (const feature of featureNames) {
      if (random() < affinity[feature]) interests.add(feature)
    }
    people.push({
      id: people.length,
      joined: day,
      plan,
      persona,
      device,
      interests,
      engagement: 0.65 + random() * 0.85,
      lifetime:
        plan === "Free"
          ? 4 + Math.floor(random() ** 1.8 * 125)
          : 80 + Math.floor(random() * 220),
      browser:
        device === "Desktop"
          ? pick([
              ["Chrome", 68],
              ["Safari", 14],
              ["Edge", 12],
              ["Firefox", 6],
            ])
          : pick([
              ["Safari", 63],
              ["Chrome", 34],
              ["Firefox", 3],
            ]),
      country: pick([
        ["United States", 42],
        ["France", 19],
        ["United Kingdom", 12],
        ["Germany", 9],
        ["Canada", 7],
        ["Netherlands", 5],
        ["Australia", 4],
        ["India", 2],
      ]),
      source: campaign
        ? pick([
            ["Product Hunt", 68],
            ["LinkedIn", 24],
            ["Direct", 8],
          ])
        : pick([
            ["Google", 44],
            ["Direct", 31],
            ["GitHub", 13],
            ["LinkedIn", 9],
            ["Other", 3],
          ]),
    })
  }

  for (let i = 0; i < 240; i++) addPerson(0, false)
  for (let day = 0; day < 180; day++) {
    const weekday = signalDate(day).getUTCDay()
    const campaign = day >= 155 && day <= 158
    const acquisition =
      Math.round(
        (9 + day * 0.055 + random() * 12) *
          (weekday === 0 || weekday === 6 ? 0.55 : 1)
      ) + (campaign ? [360, 165, 85, 35][day - 155] : 0)
    for (let i = 0; i < acquisition; i++) addPerson(day, campaign)
    // Weekly reviews and a month-end reporting deadline drive repeat sessions.
    const reporting = weekday === 5 || day === 172 || day === 178
    const automationRelease = day >= 167
    const automationLaunch = day === 167 || day === 168
    const integrationIncident = day === 173 || day === 174

    for (const person of people) {
      const age = day - person.joined
      if (age > person.lifetime) continue
      const newUser = !firstSeen.has(person.id)
      const habitual =
        person.persona === "Collaborator"
          ? 0.56
          : person.persona === "Builder"
            ? 0.43
            : person.persona === "Analyst"
              ? reporting
                ? 0.35
                : 0.23
              : 0.1
      const probability =
        newUser && age === 0
          ? 0.94
          : habitual *
            weekdays[weekday] *
            person.engagement *
            (age < 4 ? 0.65 : 1)
      if (random() >= probability) continue
      if (newUser) firstSeen.set(person.id, day)
      const visits = newUser
        ? 1
        : 1 +
          (random() < (reporting && person.persona === "Analyst" ? 0.85 : 0.2)
            ? 1
            : 0) +
          (reporting && person.persona === "Analyst"
            ? Math.floor(random() * 3)
            : 0)

      for (let visit = 0; visit < visits; visit++) {
        const features: Array<string> = []
        const pages = newUser
          ? ["/onboarding"]
          : [
              pick([
                ["/boards", 58],
                ["/", 23],
                ["/activity", 13],
                ["/settings", 6],
              ]),
            ]
        for (const feature of featureNames) {
          if (!person.interests.has(feature)) continue
          const usage =
            feature === "Boards"
              ? 0.85
              : feature === "Search"
                ? 0.42
                : feature === "Comments"
                  ? 0.63
                  : feature === "Reports"
                    ? reporting
                      ? 0.98
                      : 0.34
                    : feature === "Automations"
                      ? automationRelease
                        ? 0.78
                        : 0.18
                      : feature === "Integrations"
                        ? integrationIncident
                          ? 0.04
                          : 0.66
                        : feature === "Exports"
                          ? reporting
                            ? 0.57
                            : 0.06
                          : 0.19
          if (random() >= usage * (newUser ? 0.3 : 1)) continue
          const repetitions =
            feature === "Automations"
              ? automationLaunch
                ? 100 + Math.floor(random() * 100)
                : 6 + Math.floor(random() * (automationRelease ? 45 : 7))
              : feature === "Boards"
                ? 1 + Math.floor(random() * 7)
                : feature === "Search"
                  ? 1 + Math.floor(random() * 4)
                  : feature === "Comments"
                    ? 1 + Math.floor(random() * 5)
                    : 1
          for (let event = 0; event < repetitions; event++)
            features.push(feature)
          // Background jobs and comments can emit many events without a page view.
          if (feature !== "Automations" && feature !== "Comments") {
            pages.push(featurePages[feature])
            if (feature === "Boards" && random() < 0.6)
              pages.push("/boards/roadmap")
            if (feature === "Reports" && reporting)
              pages.push("/reports/weekly")
          }
        }
        sessions.push({
          day,
          user: person.id,
          firstDay: firstSeen.get(person.id)!,
          device: person.device,
          browser: person.browser,
          country: person.country,
          plan: person.plan,
          source: newUser
            ? person.source
            : pick([
                ["Direct", 77],
                [person.source, 23],
              ]),
          features,
          pages,
        })
      }
    }
  }
  return sessions
}

export function readSignalsSearch(search: Record<string, unknown>): {
  preview?: boolean
} {
  return search.preview === true || search.preview === "true"
    ? { preview: true }
    : {}
}

export function signalDate(day: number) {
  return new Date(signalDemoEnd - (179 - day) * dayMs)
}

export function selectSignalSessions(
  sessions: Array<SignalSession>,
  from: number,
  to: number,
  filters: SignalFilters = {}
) {
  return sessions.filter(
    (session) =>
      session.day >= from &&
      session.day <= to &&
      (!filters.device || session.device === filters.device) &&
      (!filters.plan || session.plan === filters.plan) &&
      (!filters.feature || session.features.includes(filters.feature))
  )
}

export function summarizeSignals(
  sessions: Array<SignalSession>,
  periodStart: number
): Record<SignalMetric, number> {
  return {
    users: new Set(sessions.map((session) => session.user)).size,
    sessions: sessions.length,
    interactions: sessions.reduce(
      (sum, session) => sum + session.features.length,
      0
    ),
    returning: new Set(
      sessions
        .filter((session) => session.firstDay < periodStart)
        .map((session) => session.user)
    ).size,
  }
}

export function signalBreakdown(
  sessions: Array<SignalSession>,
  dimension: SignalDimension
): Array<SignalBreakdown> {
  const grouped = new Map<string, Set<number> | number>()
  const unique =
    dimension === "features" ||
    dimension === "devices" ||
    dimension === "browsers" ||
    dimension === "countries"
  for (const session of sessions) {
    const names =
      dimension === "features"
        ? session.features
        : dimension === "pages"
          ? session.pages
          : dimension === "events"
            ? session.features.map((feature) => featureEvents[feature])
            : [
                session[
                  dimension === "sources"
                    ? "source"
                    : dimension === "devices"
                      ? "device"
                      : dimension === "browsers"
                        ? "browser"
                        : "country"
                ],
              ]
    for (const name of names) {
      if (unique) {
        const users =
          (grouped.get(name) as Set<number> | undefined) ?? new Set<number>()
        users.add(session.user)
        grouped.set(name, users)
      } else
        grouped.set(name, ((grouped.get(name) as number | undefined) ?? 0) + 1)
    }
  }
  const total = unique
    ? new Set(sessions.map((session) => session.user)).size
    : dimension === "pages"
      ? sessions.reduce((sum, session) => sum + session.pages.length, 0)
      : dimension === "events"
        ? sessions.reduce((sum, session) => sum + session.features.length, 0)
        : sessions.length
  return Array.from(grouped, ([name, value]) => ({
    name,
    count: value instanceof Set ? value.size : value,
    share: total
      ? ((value instanceof Set ? value.size : value) / total) * 100
      : 0,
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export function signalChange(current: number, previous: number): number | null {
  return previous ? ((current - previous) / previous) * 100 : null
}

export function buildSignalSeries(
  current: Array<SignalSession>,
  previous: Array<SignalSession>,
  days: number,
  metric: SignalMetric
) {
  const start = 180 - days
  return Array.from({ length: days }, (_, index) => ({
    date: signalDate(start + index).toISOString(),
    current: summarizeSignals(
      current.filter((session) => session.day === start + index),
      start
    )[metric],
    previous: summarizeSignals(
      previous.filter((session) => session.day === start - days + index),
      start - days
    )[metric],
  }))
}
