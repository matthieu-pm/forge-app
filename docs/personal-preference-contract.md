# Personal preference contract

Implemented for FOR-128 on 28 October 2026.

`apps/forge/src/lib/personal-preference-contract.ts` is the shared, browser-independent
schema/defaults contract. The loader accepts the legacy flat object and version 1
envelopes (`{ version: 1, values: { ... } }`). Each known field is validated
independently. Invalid fields use their defaults; unknown values stay in the
original source. Invalid JSON and unsupported versions produce safe defaults.
Reading never changes storage or uploads data.

Explicit edits use the validated writer. It retains unknown fields and envelope
metadata, preserves damaged source bytes under a unique local recovery key before
replacement, and refuses to overwrite unsupported versions. Failure to preserve
the source aborts the edit. The Preferences screen reports a save failure before
applying optimistic changes.

The user confirmed that appearance follows the account across web and macOS.
Personal settings are account choices. OS permissions/capabilities, window geometry
and transient drafts are device facts, excluded from account patches. No current
personal field represents workspace administrative policy. The cache-key contract
separates account, workspace and device records, includes actor identity, and uses
JSON tuple encoding to avoid delimiter collisions. Identifiers come from trusted
adapter context; a storage key itself is not authorization.

FOR-127 will integrate authenticated persistence and use the scoped cache keys.
The existing legacy browser key remains a local source without inferred account
ownership. FOR-144 will implement consent/conflict-aware account import. Strict
outbound patches reject owner IDs, roles and unknown keys; future server handlers
must derive identity from the session and enforce authorization independently.

FOR-22's [legacy browser import policy](legacy-browser-import-policy.md) requires
explicit ownership/destination confirmation, excludes other-account personal
sources, and allows a conflicting preference field to replace an account value
only after an explicit choice and a server revision check. Source and recovery
backups remain intact until reconciliation and separate explicit cleanup.

Verification: focused contract/storage/Preferences integration tests, app TypeScript
check and ESLint on the modified TypeScript files. These checks establish the pure
contract and current browser adapter; they do not certify account synchronization
or a packaged desktop release.
