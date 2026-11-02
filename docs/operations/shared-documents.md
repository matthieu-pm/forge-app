# Shared documents · FOR-61

The accepted product rules are recorded in [FOR-61](https://linear.app/atriumcrm/issue/FOR-61/create-and-edit-shared-documents-with-revision-conflicts). Implementation branches from `94db2f8`. The review and production release are tracked in [the release report](../qa/for61/review-and-release.md).

## Enablement and rollback

1. Reconcile the migration journal with any earlier merged schema work, regenerate its snapshot if ordering changes, and apply `0066_shared_documents` with the repository's serialized migration runner against the approved direct connection.
2. Confirm application-role privileges for `document_revisions`, the expanded document table, and readiness migration receipts.
3. Set `FORGE_SHARED_DOCUMENTS_ENABLED=true` in the intended environment and deploy the reviewed source. The default is false when `FORGE_SERVICE_ENVIRONMENT=production`.
4. Verify two authenticated sessions, a stale-save conflict, history restore, and revocation before enabling broadly.

To disable writes/reads in this slice, set the gate to false. Retain the expansion, history, and receipts; do not contract the schema during application rollback. Creation/edit/restore/share/delete commands commit the document, revision, receipt, audit, outbox metadata, and any selected legacy-source consumption in one transaction. Receipts contain identity/revision only, and all replays reauthorize current access. Conflict responses have no business effect and do not reserve a successful receipt. Deleted document IDs remain tombstones and cannot be recreated through legacy imports.

The browser adapter requires a current Better Auth session bound to its workspace/session. API keys and agent credentials have no declared document scope contract and are denied. File authorization uses the same live document predicate, which excludes deleted documents. Resource link sharing never grants access to the source issue/team/project.

## Reproduction

Use a private connection JSON containing `connection` (migration owner/direct) and `applicationConnection` (ordinary application login) for the dedicated database `forge_documents_acceptance_v3`, branch `br-autumn-union-za0opf1e`. The test harness verifies the target before mutation and removes its owned users, workspaces, and receipts afterwards. The native SQL harness never targets production. Production browser verification uses the separately guarded release mode described below.

```sh
cd apps/forge
FORGE_DOCUMENT_TEST_DATABASE_FILE=/private/connection.json bun run test:documents:postgres
# Start the app against that same ordinary application connection at localhost:3161.
FORGE_DOCUMENT_TEST_DATABASE_FILE=/private/connection.json bun run test:documents:browser
bun run typecheck
bun run build
```

The app must use its development environment and enable shared documents. Browser checks use temporary Better Auth accounts and assert cleanup. No credentials or raw connection strings belong in evidence or commits.

## Acceptance evidence

- **AC-01 / AT-01:** PostgreSQL and two real signed-in browsers verify shared content, plain-text projection, owner, edit attribution, timestamps, and revision metadata.
- **AC-02 / AT-02:** concurrent SQL writers commit one winner; browser tests hold Bob's stale write while Alice commits a newer version, then verify both the latest saved content and Bob's draft, reload recovery, explicit reviewed save, and history restoration.
- **AC-03 / AT-03:** closed JSON validation rejects unsafe nodes, event/style attrs, executable URLs, and unsupported embeds on create/import/save; renderer tests verify unsafe JSON never reaches Tiptap. Rejected imports retain their source. Device recovery cannot smuggle a different operation or target into Retry.
- Additional checks cover exact lost-response replay, changed-input rejection, current private-source access, sharing grants and revocation, creator/admin deletion, history pagination, cross-workspace denial, feature-gate denial, and transactional rollback of document/receipt/audit/outbox after a real database history fault.
- Editor tests cover typing during an in-flight request, exact uncertain-command retry before later typing, safe-link normalization without save loops, and device-draft recovery/retirement.

Initial acceptance screenshots: [conflict](../qa/for61/conflict.png), [editor](../qa/for61/editor.png), [mobile](../qa/for61/mobile.png). Release verification and production artifacts are recorded separately in the release report. Packaged macOS is not certified by these browser checks.

## Initial implementation validation · 2 November 2026

All 13 dedicated PostgreSQL acceptance cases and the two-browser flow passed. Workspace TypeScript, the production build and protected Workflow handlers, four Workflow tests, schema-drift verification, and changed-source lint (zero errors, 32 warnings) passed. Fixtures were removed; the ordinary application role is not a superuser.

An earlier full app run passed 2,438 tests. The final full run passed 2,435 cases and hit three timing failures: two preference-fixture setup timeouts and an agent-shell asynchronous wait. All three affected files passed isolated reruns (41 tests). A separate rerun had a worker-startup timeout in unchanged Electron navigation tests; all four of those cases passed alone. This is reported as broader-suite timing flakiness, not a clean final full-suite result. No unrelated timeout thresholds were changed. See [the sanitized acceptance record](for61-acceptance-evidence.json).

## Reviewed production release · 2 November 2026

The reviewed source `0e867c3` passed 2,498 app tests with no unhandled errors, 20 real PostgreSQL cases under the ordinary application role, four Workflow tests, workspace TypeScript, the production build/protected handlers, two-session browser acceptance, and changed-source lint (zero errors, 37 warnings). Both Vercel GitHub checks passed.

Migration `0066_shared_documents` advanced production from 66 to 67 canonical receipts and replayed with zero changes. The feature gate is enabled. Deployment `dpl_B6M9rc97JDFsbC8DogamJ3FqjxWc` passed staged health checks, was promoted to app.forgenow.tech, and passed the full authenticated two-session flow. Its owned fixtures were removed and existing record counts were unchanged. No error/fatal runtime log groups appeared in the queried release window. See [the release evidence](for61-review-release-evidence.json) and [review report](../qa/for61/review-and-release.md).

Production browser verification is separately guarded by a clean exact authorized revision, the explicit production connection file, and the fixed production branch/host/database. It creates and removes only its own temporary workspace/accounts; the native SQL suite remains restricted to the acceptance database.
