# Shared documents

FOR-61 replaces the prototype document save path with canonical PostgreSQL documents and immutable saved revision snapshots. Team Documents, team overview creation, project resources, and the workspace Documents page use the same authenticated commands and editor. `/workspace/documents?document=:id` opens an authorized document without requiring access to its private source page.

A confirmed save persists validated Tiptap JSON, a plain-text projection, title, icon, owner, creation/edit timestamps, editor attribution, and a monotonically increasing revision. Other signed-in teammates read the same record. The UI labels pending edits as unsaved until the server confirms them. Concurrent co-editing is not promised: stale writes return a conflict with the latest authorized version and leave the submitted draft intact. The author explicitly saves a reviewed draft against the displayed revision or discards it in favor of the latest version.

Failed and uncertain saves retain their original command identity and revision baseline. Unsaved drafts are journaled on this device under the verified user, workspace, document, and editor instance. Reloaded drafts require review before retrying; newer typing during an in-flight save is retained and saved against the confirmed successor revision. Device-storage failures are visible and offer a JSON download. Recovery records cannot change the operation or target document. Read caches and delayed responses are fenced against session/workspace changes; document refreshes reauthorize on focus and every 15 seconds.

History is available to current document readers, in pages of 30 revisions. Restoring a revision appends a new revision after a fresh concurrency check. Every teammate with current document access may edit. Only the creator or a workspace owner/admin may delete, and only owners/admins can change explicit workspace sharing. Source visibility follows the [resource visibility policy](resource-visibility-policy.md); sharing a document does not expose its private source backlinks. Deletion hides the canonical document, history, and its file authorization. Saved revision content is retained with the document; FOR-61 does not introduce a separate history-expiry policy.

The shared document renderer validates content before initializing Tiptap or any node view. Supported content includes headings, lists/checklists, quotes, code, safe links, raster images, collapsible sections, callouts, Mermaid diagrams, and validated analytics charts. Arbitrary nodes, event/style attributes, executable links, SVG data images, and active attachment embeds are rejected. Safe link attributes are normalized. Rejected saves and imports preserve the original author draft; they do not silently strip unsupported content and report success. A source JSON download is available when content cannot be opened. General document attachment upload/public API/agent adapters remain outside this slice; those transports are not enabled by FOR-61.

Earlier team/project resource documents are offered for explicit import. Successful import starts canonical history and consumes the selected legacy copy in the same command transaction. Rejected imports leave the original copy available for download. Old team-resource snapshots cannot republish a canonical document or its deletion tombstone. This is an individual-document conversion path, not completion of the broader FOR-126 planning-content migration.

Favorites remain personal preferences. Full-width writing, document icons, team section assignments, title filtering, ordering, owner/timestamp columns, and deep links remain available. Team resource sections and Loops continue to use their existing contracts.

Production enablement requires migration `0066_shared_documents` and `FORGE_SHARED_DOCUMENTS_ENABLED=true`. The gate defaults off in production and on in development; undeclared external-credential adapters remain denied. See the [operator and acceptance guide](operations/shared-documents.md).

The investigation and screenshots below document the earlier prototype and its reference research; their browser-local persistence description has been superseded by FOR-61.

## Linear investigation

The user's selected references show a team Documents list with Name, Created, Last edited, and Owner columns, a collapsible Team documents group, and a full-page document editor with breadcrumbs, icon, title, body placeholder, favorite, options, metadata/display, copy-link, and subscription controls.

Linear's [Documents documentation](https://linear.app/docs/documents) establishes that its documents use the same editor as issues, save and sync edits in real time, support version history and slash-command formatting, and automatically subscribe the creator. Its [team documents announcement](https://linear.app/changelog/2026-06-04-team-documents) describes creation from team home and grouping pinned resources into sections. These are documented behaviors, not claims about captured network or backend internals.

### REA artifact evidence

Inspected installed `/Applications/Linear.app/Contents/Resources/app.asar`, SHA-256 `dcb7a9500b83e76f29a073452f40748c9aa1c5ca1fc6f7e95558448e278ddbfe`.

| Question | Finding | Evidence and boundary |
| --- | --- | --- |
| Installed application | `@linear/desktop` version `1.32.7`, main `./out/main/index.js` | Package bytes and REA inventory; analysis `ev_a998bcc15a88f70b32fea0a2271128926a4d7dae5e7f4db63a2573670d0632f5`, summary `ev_cd75e9f7513f80ffe8ff4a224718280109d6830c39ea916c8228f44f27ec3234` |
| Renderer entry | Production host `https://linear.app`, entry `${host}/auth/desktop`, used by main-process `loadURL` | Constants module `ev_bac9f8312bd2bfa6a63cbe7c0953c7e9b7075a8c79c6dd092667e4f24c6a8339`; main module `ev_1732298179c732ad76593c2608fa470cac376536ae1e0fd0bde225603638191e` |
| Document editor shipped in ASAR? | No editor bundle in the complete archive path inventory; five JavaScript sources implement shell/preload/server functions. Local renderer index HTML is empty. | Inventory pages `ev_9feb55f06bf787b94d621d9adf557b0da2d12dfd4f5a39034d344dce534e82c1`, `ev_0c7a5d161c3bef12de93b777c6c9f31f1ef4136216aebe86ca6405189feb9d7d`. Supports the inference that the document UI comes from the remote client. |
| Exact web editor implementation and protocol | Unknown from this artifact | No accessible debugging endpoint was established. Native accessibility exposed the document list, but the current computer connection did not execute navigation/menu actions reliably. No creation, editing, or network saving behavior was verified in Linear. |

Static analysis coverage is partial: semantic analysis of the main/review-preview sources exhausted its default heap. Three unpacked native addons had integrity mismatches; the agent explicitly used record-and-continue and retained them as untrusted. This does not establish execution or invalidate the separately read package metadata, URL literals, or archive member inventory. Tiptap in Forge is a reuse decision, not a finding about Linear's editor internals.

## Checks

All 30 relevant component, storage, content compatibility, rich editor, template validation, and navigation regression tests passed. Typecheck, scoped ESLint, formatting, the production build, and its protected Workflow handler check passed.

Browser verification covered creation from Documents and team overview, rich-text formatting, persistence across reload, breadcrumb/history navigation, list metadata, filtering, collapsing groups, favorites, copying the exact deep link, the full-width display control, deletion, and a 390 px mobile editor without horizontal overflow. Verification documents were removed after testing. Console review found the previously observed TanStack devtools `path.endsWith` error, with no document-flow failures.

Captured evidence:

- [Blank editor](qa/documents/blank-editor.png), [populated editor](qa/documents/editor.png), and [document list](qa/documents/list.png): 1280 × 720 browser viewport, 1× density.
- [Mobile editor](qa/documents/editor-mobile.png): 390 × 844 browser viewport, 1× density.

The user’s Linear screenshots show a dark theme, while the browser verification used the active Forge light theme. Global theme, sidebar content, and the existing Loops navigation were preserved. The visual review checked the document header, centered writing column, title and body rhythm, thin line icons, and compact grouped list; it does not establish pixel-identical global chrome or dark-theme screenshot equivalence. The initial document-icon fallback and focused title outline were corrected before the final captures. Linear’s subscription bell was not added because this local document store does not deliver document notifications.
