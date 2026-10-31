# Protected client sessions and offline drafts (FOR-52)

Protected UI is rendered only after the server verifies the user, session and workspace and the router reloads its active loaders. Auth mutations retire the browser request generation before changing identity and again when they settle. The shell unmounts while identity is unknown; account/workspace switches cannot reuse the previous shell's component state.

Global Start function middleware cancels requests from a retired generation and rejects their results even if a transport ignores cancellation. Router cache/preloads and active loader work are retired, team-list request deduplication includes the generation, and canonical issue queries retain their actor/workspace/session/epoch keys. Multi-step migration and edit/create operations check their original generation between steps. Server authorization remains mandatory for every request.

The existing preference session event now invalidates the whole protected client scope. A storage event containing only a transition phase and random nonce broadcasts this boundary to other tabs; it carries no account identity or product content. Focus, reconnection and periodic verification recheck live identity. A failed verification never establishes an offline identity from device storage.

## Recovery policy

The user approved persistent device recovery in the FOR-52 implementation conversation on 31 October 2026. This extends the earlier memory-only projection policy for unconfirmed writes:

- Read caches remain in memory; dynamic server responses remain `private, no-store`.
- Only pending writes are journaled in `localStorage`, under `["forge.unsaved-drafts",1,userId,workspaceId]`. Account/workspace metadata and the versioned payload schema are checked on read. The journal is excluded from legacy import discovery.
- Recovery is available after the same account/workspace has been verified by the server again. A fully offline reload cannot authenticate or display protected data; reconnect to verify identity before recovering drafts.
- Logout/switch clears active caches, pending queues and component state. Device recovery copies remain scoped to their original account/workspace until acknowledgement, explicit discard or browser storage removal. They are never loaded for another account/workspace.
- Recovery retains the original command identity and expected revision, including uncertain writes. A new session of the same account can retry with its current session binding. Unsaved changes are labeled as unconfirmed; issue/comment publication is never inferred from a local save.
- Issue creation drafts autosave as unpublished drafts. Recovered issue creates, comments and edit commands require user action to publish/retry. New typing after an uncertain creation is kept separately when restoring the original retry draft. Preference drafts retain their patch, baseline and retry command too.
- Pending product writes may resume when the user retries or edits. This saves their private draft/projection; it does not publish an issue/comment. Normal server revision conflicts still require review.
- Unsent consecutive typing is coalesced; commands already sent are immutable. Another tab's unconfirmed writes and inaccessible team drafts are preserved when this tab acknowledges its own changes.
- Malformed/unsupported recovery payloads are preserved. Device quota/permission failures show that recovery is only available in the current tab. A leave warning remains while writes are pending. Device recovery is best effort, subject to browser storage availability/eviction.

## Verification

`FORGE_CACHE_SCOPE_TEST_DATABASE_FILE=/path/to/dedicated-acceptance.json bun run --cwd apps/forge test:cache-scope:browser` runs the guarded local Chromium acceptance scenario. The database file must reference the existing dedicated acceptance database/branch, and the local server must run this branch with that database. `FORGE_CACHE_SCOPE_BROWSER_URL` defaults to `http://localhost:3152`. The script creates uniquely marked fixtures and removes them in `finally`.

The scenario holds account A's actual server response, signs into B, asserts A's rows never appear in B, and checks another open tab. It types and submits offline, verifies zero committed issues, reloads and recovers the unpublished draft, checks another account cannot read it, and switches the same account between workspaces.

Unit/component coverage includes abort-ignoring transports, session storage events, scoped draft reload/retry, unchanged idempotency identities, late acknowledgement, corrupt storage, preservation of another tab's drafts, preference recovery and the persistent navigation shell within one verified scope.
