# Team documents

Creating a document from a team's overview or Documents tab now creates a saved blank document and opens a dedicated editor page. The page is addressable at `/teams/:teamSlug/documents?document=:id`; reload and browser history preserve the selected document. The Documents breadcrumb returns to the list.

The editor uses the existing Tiptap rich-text editor, including formatting, lists, slash commands, and the shared icon picker. Title, content, and icon edits save synchronously to the existing browser-local team store. Favoriting and moving between resource sections are available from the header. The metadata popover shows the owner and available creation/edit timestamps and can expand the writing area. The list supports title filtering, sorting by name/creation/edit time/owner, column visibility, a collapsible team group, opening, and deleting documents.

Existing documents remain readable. Their plain-text content is converted into paragraph nodes when opened; formatting is stored in an additive `body` field, while `content` remains a plain-text version for existing resource readers. Historical owner and creation timestamps remain unknown when old records do not contain them. Section assignments are retained.

Failed writes retain the current draft with a retry action. Leaving after a failed save requires explicitly discarding unsaved changes. Successful edits need no Save button. This is still browser-local storage: shared editing, cross-device synchronization, notification delivery, and document version history are not implemented by this change.

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
