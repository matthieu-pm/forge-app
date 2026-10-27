# Workspace Members QA

final result: passed

## User correction: reuse the actual Teams table

The first implementation shared the header/search/display controls but kept a separate table treatment. The user correctly identified the missing header separator and the square, full-width row hover. Both pages now render `WorkspaceDirectoryTable`, `WorkspaceDirectoryTableHeader`, `WorkspaceDirectoryRow`, and `WorkspaceDirectoryCell` from `apps/forge/src/components/workspace-directory-table.tsx`.

- The separator, hover background, rounded edges, and side insets live in that shared module.
- Browser inspection confirmed the same 1px separator, 10px corner radii, and 4px left/right hover insets on both pages, with 48px row height (48.5px measured for the first collapsed-border row).
- Updated evidence: `docs/qa/members/teams-row-hover.png` and `docs/qa/members/members-row-hover.png`, both captured at 1280 × 720 CSS viewport with identical 1016 × 220 content crops. The previous Linear comparison documents the initial design work; the user's shared-Teams-table correction supersedes the earlier decision to remove the separator.
- 15 focused Members/Teams tests, TypeScript, scoped ESLint, formatting, and diff checks pass after the extraction.

## Scope and visual evidence

Evidence paths below are relative to `docs/qa/members/`.

- Target: the user's Linear Members screenshot, `Linear Appshot 2026-10-27T00-24-49.450Z.png`. A matching live Members screen was captured without changing Linear data: `linear-members-reference.png` (3600 × 2260, 2× density).
- Normalized source: `linear-members-reference-1x.png` (1800 × 1130, 1× density).
- Implementation: http://localhost:3000/workspace/members; `members-desktop.png` (1280 × 720 CSS/pixels, 1× density).
- Combined full-view evidence: `comparison-full.png`. Combined detailed header/table evidence: `comparison.png`. The content regions preserve native 1× typography; the different viewport widths and native title bar are explicitly excluded from pixel-accuracy claims.
- State: dark theme, default name ordering, all columns visible, no active search/filter/dialog. The source has two Linear accounts; Forge shows its actual workspace member, avatar, owner role, membership identifiers, dates, and online state. Reference identities and role assignments were not fabricated.
- Existing Teams styling and the existing Forge shell intentionally take precedence over copying Linear's sidebar, font, exact viewport proportions, and color values, as requested by the user.

## Findings and comparison history

1. Initial comparison (`comparison-initial.png`) found an unnecessary table-header divider and identical filter/display icons. These were moderate, actionable differences in the member content area.
2. Removed the member table header divider and used a distinct library filter icon. Recaptured the implementation and reviewed the combined full-view and focused comparison again. This initial review missed the Teams table parity requirement; the corrective pass above supersedes that conclusion.

## Required fidelity surfaces

- Typography: existing Forge/Teams font, 14px compact header and 12–13px directory text; secondary usernames remain below names, with truncation for long values. Font and type weight intentionally follow the reused Teams components.
- Layout: shared 44px header, shared search toolbar, right-aligned filter/display controls, flexible name column, compact role/date/team/presence columns, 48px member rows. Persistent header stays above the scrolling directory. A minimum table width preserves readable columns with horizontal scrolling in narrower containers.
- Colors: existing background/foreground/muted/border tokens; purple owner/admin labels and green online status, consistent with the reference's semantic treatment.
- Assets: real member avatar and existing Avatar fallback; Hugeicons for search, sorting, filter, display, teams, and invite. No generated or placeholder reference account imagery is used.
- Copy/content: Members, Invite members, Find members, Name, Role, Joined, Teams, Last seen; real workspace data; informative search/filter empty state.

## Verification

- Browser: live workspace data loaded; search produced an empty state and cleared correctly; role filtering changed results; clearing filters restored the member; Joined column toggled off/on; invite dialog opened and canceled; member details opened and exposed valid team links. No invitation was sent from the browser.
- Automated: 23 tests passed across the new Members component, existing Workspace Teams, and existing Members Settings. Tests cover compound filters, sorting, column visibility, membership accuracy, invitation failure/success, and management permissions.
- TypeScript, scoped ESLint, formatting, diff whitespace checks, and production build passed. The final icon/divider refinements were additionally typechecked and linted.
- React review: data is derived from loader props; shared controls have typed interfaces; dialog and filter state is local; lists have stable IDs; directory and controls have accessible names; invitation submission prevents duplicate requests and retains input on failure.
- Console: the previously observed TanStack Router devtools `path.endsWith` error appeared; no Members component failure was observed.
- Not verified: real email delivery (server call mocked in tests), a mobile browser viewport, and a pixel-identical 1800px browser capture. These do not block the requested desktop feature; no claim is made that email was sent or that every viewport is visually identical.

## Implementation checklist

- [x] Replace the workspace Members placeholder with a working directory.
- [x] Share header, search toolbar, and display controls with Teams.
- [x] Use authenticated member data and visible team memberships.
- [x] Implement search, role/team/activity filters, sorting, column toggles, member detail preview, and permission-gated invitations.
- [x] Verify existing Teams behavior after extracting shared components.
- [x] Preserve unrelated Signals work in progress.

The previous root QA report is preserved as `previous-design-qa.md` in this directory; its earlier issue-detail-panel sign-off remains historical and is not changed by this Members result.
