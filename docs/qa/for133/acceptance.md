# FOR-133 comment submission shortcuts

Verified locally on 3 November 2026 at implementation commit
`2e4bd49b97eeb6a58854db6f8a731ade6be42a6f` on macOS, Node 24 and Bun 1.3.5.
The implementation uses the existing account preference and comment command;
it adds no schema or production configuration.

## Contract and coverage

The product owner confirmed Command on macOS and Ctrl on Windows/Linux. Only the
configured action submits. Shift+Enter always inserts a newline. Extra modifiers,
IME composition (including key code 229), and repeated held keys cannot submit.

One policy serves canonical issue root comments, replies and edits, the existing
local issue/review comment and reply component, and local issue edits. Settings,
visible hints, accessible descriptions and button shortcut metadata agree. A
preference refresh updates an open composer without replacing its draft.

Canonical submission continues through `sendIssueComment`, its durable command
checkpoint, and the authorized canonical comment command. The synchronous guard
blocks concurrent keyboard/click dispatch. Upload, review, empty, deleted and
pending states block submission. A request failure keeps the exact document,
uploads and command identity locked for retry. Capture handling also works while
the editor is read-only, which ProseMirror's editable key handler does not.
Existing local-only review/issue persistence remains local; this story does not
migrate those surfaces to shared storage.

The existing `FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED` rollout gate controls account
preference availability. A disabled preference client uses Command/Ctrl+Enter;
the setting stays disabled through the existing settings fieldset. No gate or
production deployment was changed. Browser/renderer coverage does not certify a
packaged Electron release (FOR-142).

## Linear reference

The requested reverse-engineer-anything skill was used on the installed Linear
app and its delivered public web bundle. [Source hashes and focused ranges](linear-reference.json)
identify the exact input and REA evidence records.

Static observations:

- The user setting `submitKeyPreference` feeds shared comment/reply composition,
  review summary composition and the shortcut display.
- The editor installs a plain-Enter submission extension in Enter mode and
  separate newline bindings. Its form wrapper routes submission to one handler.
- Failure handling restores the prior body only if its content revision has not
  advanced, preserving newer work.
- Linear's form wrapper also accepts its platform modifier in Enter mode. Forge
  deliberately follows the owner's confirmed stricter contract above.

Live read-only browser observation in the owner's signed-in Linear workspace
confirmed the macOS choices shown as Command+Enter and Enter, and shared root and
reply forms on FOR-133. No preference was changed and no browser comment was sent.
The submit/failure conclusions above are static findings, not claims that Linear
submission or failure behavior was exercised live.

The installed desktop ASAR analysis is partial: three unpacked native helper
integrity mismatches were retained as untrusted, and two large module semantic
analyses exhausted their heap. The web follow-up used four small inert slices
(4 parsed files, zero parse failures) bound to the full public bundle's SHA-256.
Its unresolved dependencies and static semantic unknowns do not prove runtime
behavior. Proprietary bundle source and private workspace content are not copied
into this repository.

## Acceptance evidence

| Acceptance test | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AT-01 / AC-01   | Pure policy matrix covers both modes, both modifier mappings, all 16 modifier combinations and non-Enter keys. Real Tiptap component tests cover macOS, Windows and Linux across root/reply/edit, newline insertion, command routing and hints. Existing local issue/review composer tests cover both modes and live account preference refresh.                      |
| AT-02 / AC-02   | Real Tiptap tests cover native and editor-view composition, key code 229, held keys, pending keyboard/click dispatch, failed draft retention, keyboard retry with the identical command object, and empty/uploading guards. Existing comment client tests verify checkpoint-before-command, lost-response identity replay, conflict preservation and session fencing. |

Focused command:

```sh
cd apps/forge
bunx vitest run src/lib/comment-submission.test.ts \
  src/components/issues/shared-comment-input.test.tsx \
  src/components/issues/issue-comment-input.test.tsx \
  src/components/issues/use-comment-submission.test.tsx \
  src/components/preferences-settings.test.tsx \
  src/lib/issue-comment-client.test.ts \
  src/components/reviews/review-detail.test.tsx \
  --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
```

Result: 7 files, 55 tests passed without unhandled errors. TypeScript and changed-file
lint passed. The production build, prerender and Workflow protection check passed
with local build-only database/auth placeholders. No database service was contacted.
The first unconfigured build stopped at prerender because DATABASE_URL was absent.
The broad suite attempt with four workers was interrupted after initiative/project
UI tests exceeded short timeouts under concurrent machine load. All three affected
files then passed with one worker and 30-second test/hook limits: 40 tests, zero
errors. A full-suite pass is not claimed.

Browser acceptance uses the actual changed composer, policy, command client and
styles in an isolated local fixture on port 3133, with simulated account
preferences, durable storage, upload controls and server transport. It verifies
real keyboard newline behavior, configured submission, pending duplicate
suppression, failure retention and exact retry. This is renderer acceptance;
it does not claim authenticated database or production acceptance.

[Successful submissions](browser-acceptance.png) and [retained failed draft](failed-draft.png)
show the rendered fixture. The verified browser recording is
`for133-shortcuts-verified.mp4` in this Dray session
`49fa9593-ee17-4a4d-94e7-485e23cf274f`. Final browser assertions: four request
attempts, three saved canonical fixture comments, a successful review submission,
retained editor focus after failure, and zero browser errors.
