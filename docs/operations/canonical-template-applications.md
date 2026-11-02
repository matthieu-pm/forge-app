# Canonical template applications · FOR-63

`FORGE_FEATURE_TEMPLATES=true` enables **Create from template** in workspace/team template directories and issue/project composers, including triage. It is off by default. No schema migration is required for the feature: it reuses `team_templates`, `team_template_defaults`, canonical issues/projects/initiative memberships, and command receipts. Initiative links additionally require `FORGE_FEATURE_INITIATIVES=true` and the workspace initiative setting.

## Application contract

The server loads the saved template, verifies its workspace, source team and visibility, and binds the selected revision using a hash of its complete payload and update time. It validates current teams, statuses, labels, members and relationships. Templates confer no access. Issue labels/statuses and project catalogs use their current canonical definitions; older unambiguous names remain readable, while new selectors save identifiers. A removed or inaccessible reference returns a repairable validation response and commits no object or receipt. The dialog retains its fields and offers an explicit reload of the latest template.

Standard issue templates preserve title, rich description, priority, assignment, estimate, labels and project selection. Sub-issues use their own content, workflow, assignment and team, and link to the new parent. A workspace template with no team requires a chosen team. Triage creation sets the parent issue's canonical triage flag; the older browser-only template-copy path has been removed.

Project templates preserve name, summary, rich description, icon, status, priority, teams, lead, members and labels. Each milestone receives a fresh identifier. Nested issues belong to the new project and retain their own issue properties. Project-only properties placed on an issue, or incompatible fields placed on a project, produce a repairable error instead of being silently discarded.

Form templates support text, textarea, select, checkbox, date and number fields. Required values, select options, real calendar dates, finite numbers and field identifiers are validated on the server against the chosen revision. A required checkbox must be checked. Answers are appended as labeled sections of the canonical issue's rich description and plain-text description, preserving their meaning after the source form changes. Template names/descriptions remain template metadata.

Project dependencies support both **Blocked by** and **Blocking**. Blocking adds the new project to the existing target project's dependencies through the same canonical project command. Targets must be currently readable/editable; ambiguous legacy names require repair. Workspace serialization and graph validation reject cycles. Normal project dependency edits retain unreadable existing links without disclosing them. Project and initiative projections filter dependency identifiers through current project visibility.

Initiative links use canonical initiative commands and existing membership rules. They do not enable initiatives or create a replacement for a missing initiative. Member/non-member team defaults remain preselection hints, with the existing form-default restrictions preserved. Issue defaults never preselect a project template.

## Transactions, retries and recovery

`templates.apply@1` composes the issue, project and initiative command callbacks on one transaction. It commits all objects, relationships, attribution, audit evidence, ordered outbox intents and one receipt together. The existing standalone command transports continue to use those same callbacks. Template management shares the workspace/definition lock order, so editing a template cannot race an accepted application.

Distinct command keys create distinct setups. Concurrent retries with the same key and input return the committed identities. Changing the input under a committed key conflicts. Replay checks live session/workspace membership, source-template visibility, result visibility and the initiative gate when applicable. Template edits do not invalidate a previously committed receipt. A deleted template or revoked result access denies replay while retaining the original retry identity.

Only a known validation failure before COMMIT permits a revised attempt. Transport errors, deferred COMMIT errors and unavailable replay results retain the original command. The private product-storage journal is written before dispatch and survives dialog closure/reload. Its input stays immutable until a confirmed result or known rollback. Protected-session fences prevent late callbacks from reopening content or writing under a retired session. Successful creation remains confirmed even if the following cache refresh fails.

## Verification

The dedicated `forge_templates_acceptance` database is on staging branch `br-autumn-union-za0opf1e`. Connections belong in a private JSON file with `connection` and `applicationConnection`; tools verify the configured and actual database identities before fixture writes. The migration helper applies the existing repository schema and grants the application test role access only in this allowlisted database.

From `apps/forge`:

```sh
FORGE_TEMPLATE_TEST_DATABASE_FILE=/private/connections.json bun scripts/for63-migrate-acceptance.ts
FORGE_TEMPLATE_TEST_DATABASE_FILE=/private/connections.json bunx vitest run src/application/templates/template-application.postgres.test.ts --no-file-parallelism
FORGE_TEMPLATE_TEST_DATABASE_FILE=/private/connections.json FORGE_TEMPLATE_BROWSER_URL=http://localhost:3163 node scripts/verify-template-applications-browser.mjs
```

The browser server must target this same database, use local-only authentication secrets, and enable the template/initiative flags. The PostgreSQL suite includes concurrent retry, distinct commands, expected field values, form validation, inaccessible/deleted references, stale revisions, atomic relationship rollback, current replay authorization, template deletion after commit, deferred COMMIT failure, defaults and hidden dependency preservation. Its injected deferred trigger is limited to its generated workspace and removed in `finally`. Fixtures are removed by deleting their owning workspace, which also removes immutable command evidence.

The browser suite signs in through Better Auth as an ordinary member, checks required forms, discards a successful creation response, reloads and retries the saved identity, creates a distinct setup, repairs invalid/stale references, and verifies canonical project detail/milestone/issue membership. Production deployment and packaged macOS qualification are outside this PR's verification environment.
