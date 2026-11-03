# Optional emoticon conversion (FOR-132)

The supported composers are the canonical issue comment, reply and comment edit
editors, all mounted through `SharedCommentInput`. The persisted account field
`general.convertEmoticons` controls the shared `EditorEmoticons` input transform.
It defaults to **false**. Explicit stored true/false choices remain intact; there
is no document rewrite, schema migration or legacy preference import.

The approved set is:

| Typed token | Output |
| --- | --- |
| `:)`, `:-)` | 🙂 |
| `:(`, `:-(` | 🙁 |
| `;)`, `;-)` | 😉 |
| `:D`, `:-D` | 😃 |

Conversion happens on a **typed ASCII space** after a complete token. The token
must begin a text block or follow whitespace, and must end at the caret before
whitespace or the end of the block. Punctuation, Enter, Tab and unsupported tokens
do not trigger conversion. All token characters must have been typed in one
uninterrupted input sequence. Moving the selection, pasting, dropping, restoring
a draft or inserting structured content resets that sequence. A subsequent typed
space never converts a pasted or restored token.

Code blocks, code marks, links (including marked labels), URL fragments,
nonempty selections, inline atoms and active IME composition are protected.
Composition completion has no delayed conversion pass. Conversion uses a bounded
range in the current ProseMirror document, preserving surrounding nodes and marks.
The typed space is inserted first, followed by a separate history event for the
token conversion. The ordinary Undo command/keyboard shortcut restores the
literal token **and its space**; Redo reapplies the conversion. Backspace retains
its ordinary editor behavior.

Existing mounted composers read the latest account setting through a stable
callback. Preference refreshes do not recreate the editor, replace its document,
move the selection or reset history. Newly mounted editors use the same account
state. A preference identity that differs from the canonical comment account
cannot enable conversion. Missing, loading and disabled preference clients leave
conversion off. Pending edits follow the existing preference client's optimistic
state and its visible save/error/conflict behavior.

The existing `FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED` gate controls preference
availability; when disabled, the persisted settings service returns disabled and
conversion stays off. FOR-46 and FOR-127 are completed prerequisites. No production
gate, deployment or connection changes are part of this implementation.

Agent prompts, local legacy comments and excluded review composers do not use the
shared structured editor. Their input remains outside this slice. General
document/template editors are also outside the comment/message preference scope.
This does not enable any excluded product feature.

## Verification

AT-01 / AC-01: extension tests cover all eight tokens, the space trigger, live
enable/disable, exact undo/redo, caret placement and preservation of formatting,
inline atoms and surrounding blocks. Component tests use the actual account
preference client fixture to refresh saved choices for existing/new comment,
reply and edit composers, and reject an account mismatch. Contract tests verify
the opt-in default and explicit saved values.

AT-02 / AC-02: extension tests protect code blocks, stored/split code marks,
links, URL fragments, restored/inserted structured content, selection replacement,
token boundaries and composition. Chromium acceptance uses real text input and
keyboard Undo/Redo, DOM clipboard paste with HTML/plain payloads, selection
replacement and a synthetic composition lifecycle. The browser fixture bundles
the same extension used in production; it needs no authenticated account or
database. Native OS IME behavior and packaged macOS certification are not claimed.
Authenticated persistence remains owned by FOR-127.

Run from `apps/forge`:

```sh
bunx vitest run src/lib/editor-emoticons.test.ts src/components/issues/shared-comment-input.test.tsx src/lib/personal-preference-contract.test.ts
FORGE_EMOTICON_EVIDENCE_FILE=/absolute/path/evidence.json bun run test:emoticons:browser
```

The browser report names the tested commit, working tree state, Chromium version,
individual AC/AT results and verification limits.
