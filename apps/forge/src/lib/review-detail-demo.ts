import type { DiffLine, ReviewDetail, ReviewFile } from "./review-detail"
import type { Review } from "./reviews-view"

const scenarios: Record<
  number,
  { path: string; before: string; after: string; test: string }
> = {
  248: {
    path: "src/components/issues/issue-composer.tsx",
    before:
      'const draftKey = "issue-draft"\nconst draft = readDraft(draftKey)\nsetTeam(nextTeam)\nsetTitle("")',
    after:
      "const draftKey = `${workspace.id}:${user.id}:${team.id}`\nconst draft = readDraft(draftKey)\nsaveDraft(draftKey, { title, description, attachments })\nsetTeam(nextTeam)\nrestoreDraft(nextTeam.id)",
    test: "restores the original draft after switching teams",
  },
  246: {
    path: "src/components/cycles/cycle-picker.tsx",
    before: "return <CycleList cycles={cycles} onClick={selectCycle} />",
    after:
      'return (\n  <CommandMenu aria-label="Assign cycle">\n    {cycles.map(cycle => (\n      <CommandItem key={cycle.id} disabled={cycle.closed}\n        onSelect={() => selectCycle(cycle.id)}>\n        {cycle.name}\n      </CommandItem>\n    ))}\n  </CommandMenu>\n)',
    test: "returns focus to the issue after selecting a cycle",
  },
  89: {
    path: "src/providers/transcript-import.ts",
    before:
      "const transcript = await provider.fetchTranscript(id)\nawait saveTranscript(transcript)",
    after:
      'const transcript = await retry(\n  () => provider.fetchTranscript(id),\n  { attempts: 3, backoff: "exponential" }\n)\nawait saveTranscript(transcript, { deliveryId: id })',
    test: "imports a transcript once after a transient timeout",
  },
  243: {
    path: "src/components/workspace/empty-state.tsx",
    before:
      '<div className="py-24">\n  <Illustration className="h-64" />\n  <h2>{title}</h2>\n</div>',
    after:
      '<EmptyState className="px-6 py-12 sm:py-20">\n  <Illustration className="h-32 sm:h-40" />\n  <EmptyStateTitle>{title}</EmptyStateTitle>\n  <EmptyStateAction onClick={onCreate}>\n    {actionLabel}\n  </EmptyStateAction>\n</EmptyState>',
    test: "keeps the primary action visible on a short screen",
  },
  241: {
    path: "src/lib/reviews-preferences.ts",
    before: "const display = JSON.parse(localStorage.getItem(key))",
    after:
      "const stored = readLocalPreference(key)\nconst parsed = displaySchema.safeParse(stored)\nconst display = parsed.success ? parsed.data : defaultDisplay\nreturn { ...defaultDisplay, ...display }",
    test: "restores defaults when saved preferences are invalid",
  },
  83: {
    path: "src/webhooks/handle-delivery.ts",
    before: "await queue.push(request.body)",
    after:
      "const event = webhookSchema.parse(request.body)\nif (await deliveries.exists(event.deliveryId)) return\nawait queue.push(event)\nawait deliveries.record(event.deliveryId)",
    test: "skips an already processed webhook delivery",
  },
  237: {
    path: "src/lib/project-search.ts",
    before: "return projects.filter(project => project.name.includes(query))",
    after:
      "const term = query.trim().toLowerCase()\nreturn projects\n  .filter(project => !project.archived)\n  .filter(project => matchesProject(project, term))\n  .sort((a, b) => matchScore(b, term) - matchScore(a, term))",
    test: "ranks exact names ahead of description matches",
  },
  235: {
    path: "src/components/calls/call-recap.tsx",
    before: "<Transcript lines={call.transcript} />",
    after:
      "<CallSummary summary={call.summary} />\n<ActionItems groups={groupByOwner(call.actions)} />\n<Collapsible defaultOpen={false}>\n  <Transcript lines={call.transcript} />\n</Collapsible>",
    test: "preserves the recap position when opening a transcript",
  },
  232: {
    path: "src/lib/sidebar-disclosure.ts",
    before: 'const key = "sidebar-disclosure"',
    after:
      "const key = `sidebar-disclosure:${workspaceId}`\nconst saved = readDisclosure(key)\nreturn saved ?? defaultDisclosure",
    test: "isolates expanded sections between workspaces",
  },
  76: {
    path: "src/providers/legacy-import.ts",
    before:
      "export async function importLegacy(payload) {\n  return legacyAdapter.parse(payload)\n}",
    after:
      "export async function importLegacy(payload) {\n  return adapter.parse(payload, { allowLegacy: true })\n}",
    test: "retains support for older provider payloads",
  },
  219: {
    path: "src/components/settings/settings-header.tsx",
    before: '<header className="px-6">{pageTitle}</header>',
    after:
      "<ContentHeader>\n  <Breadcrumb items={settingsBreadcrumbs(pathname)} />\n</ContentHeader>",
    test: "keeps breadcrumbs visible while content scrolls",
  },
}
function changedLines(before: string, after: string): Array<DiffLine> {
  let oldLine = 18,
    newLine = 18
  return [
    { kind: "context", content: "", oldLine: oldLine++, newLine: newLine++ },
    ...(before ? before.split("\n") : []).map((content) => ({
      kind: "remove" as const,
      content,
      oldLine: oldLine++,
    })),
    ...after.split("\n").map((content) => ({
      kind: "add" as const,
      content,
      newLine: newLine++,
    })),
    { kind: "context", content: "", oldLine, newLine },
  ]
}
export function createSimulatedReviewDetail(
  review: Review,
  userId: string,
  userName = "You"
): ReviewDetail {
  const scenario = scenarios[review.number] ?? scenarios[248]
  const sha = (offset: number) =>
    (review.number * 4096 + offset).toString(16).padStart(7, "0")
  const testPath = scenario.path.replace(/\.(tsx?)$/, ".test.$1")
  const files: Array<ReviewFile> = [
    {
      path: scenario.path,
      category: "Implementation",
      language: "tsx",
      commit: sha(1),
      lines: changedLines(scenario.before, scenario.after),
      hiddenBefore: [
        {
          kind: "context",
          content: "// Fictional source for the Reviews preview",
          oldLine: 15,
          newLine: 15,
        },
        {
          kind: "context",
          content: 'import { readLocalPreference } from "./preferences"',
          oldLine: 16,
          newLine: 16,
        },
        { kind: "context", content: "", oldLine: 17, newLine: 17 },
      ],
    },
    {
      path: testPath,
      category: "Tests",
      language: "tsx",
      commit: sha(2),
      lines: changedLines(
        "",
        `it("${scenario.test}", async () => {\n  const workspace = createTestWorkspace()\n  const result = await exerciseChange(workspace)\n  expect(result).toMatchExpectedBehavior()\n})`
      ),
    },
    {
      path: `docs/changes/pr-${review.number}.md`,
      category: "Documentation",
      language: "markdown",
      commit: sha(3),
      lines: changedLines(
        "",
        `# ${review.title}\n\n${review.description.split("\n")[1]}\n\nThis example is part of the simulated Reviews preview.`
      ),
    },
  ]
  if (review.number === 248)
    files.push({
      path: "src/generated/review-manifest.json",
      category: "Generated",
      language: "json",
      generated: true,
      commit: sha(3),
      lines: changedLines(
        '{ "drafts": false }',
        '{\n  "drafts": true,\n  "scope": "workspace-user-team"\n}'
      ),
    })
  return {
    branch: `dev/${review.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    baseBranch: "main",
    checks:
      review.number === 89
        ? "failed"
        : review.status === "draft"
          ? "pending"
          : "passed",
    files,
    people: [
      { id: userId, name: userName },
      { id: "reviews-demo:maya", name: "Maya Chen" },
      { id: "reviews-demo:leo", name: "Leo Martin" },
      { id: "reviews-demo:amira", name: "Amira Hassan" },
      { id: "reviews-demo:nora", name: "Nora Kim" },
    ],
    issues: [
      {
        id: `demo-issue:${review.number}`,
        identifier: `FOR-${review.number - 100 > 0 ? review.number - 100 : review.number}`,
        title: review.title,
      },
      {
        id: "demo-issue:142",
        identifier: "FOR-142",
        title: "Improve the workspace navigation experience",
      },
    ],
    commits: [
      {
        sha: sha(1),
        title: review.title,
        author: review.author.name,
        createdAt: review.openedAt,
      },
      {
        sha: sha(2),
        title: "Cover the updated behavior",
        author: review.author.name,
        createdAt: review.updatedAt,
      },
      {
        sha: sha(3),
        title: "Document the change",
        author: review.author.name,
        createdAt: review.updatedAt,
      },
    ],
  }
}
