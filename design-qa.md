# Workspace teams design QA

## Latest member-avatar iteration

- Source visual truth:
  - `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/codex-clipboard-bad983c1-d515-45e0-9709-23f6e231bcfe.png`
  - `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/codex-clipboard-7d2c5aa9-43d5-41b8-a796-a85ad368813e.png`
  - `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/codex-clipboard-4530a8f5-2bb8-48d6-a335-9e0b80254ff5.png`
  - `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/codex-clipboard-c6c4cbf8-bf05-4be3-88a2-8cd1401a02df.png`
- Rendered implementation: unavailable; the in-app browser redirected the local workspace route to the sign-in screen.
- Viewport: in-app browser desktop viewport.
- Source pixels: 216 × 108, 1536 × 840, and 1067 × 242.
- Implementation pixels, CSS size, and density normalization: unavailable because the authenticated component could not be rendered.
- State: intended dark workspace team table, one-member and stacked-member states, plus avatar tooltip.
- Browser interaction attempted: opened `http://127.0.0.1:3000/workspace/teams`; authentication redirected to the sign-in screen before the team table rendered.
- Console errors checked: not applicable because the target route did not render.

### Latest findings

- [P2] Visual comparison is blocked by authentication.
  - Location: local in-app browser preview.
  - Evidence: the source avatar references opened successfully, but the implementation route rendered the sign-in screen.
  - Impact: avatar size, overlap, tooltip placement, and row alignment cannot be compared against the references in a browser-rendered state.
  - Fix: sign in to the local Forge preview in the in-app browser, recapture the team table and tooltip state, then complete the focused comparison.

### Latest implementation checklist

- [x] Return up to five real member previews per team.
- [x] Render one 24 px avatar per preview with an overflow count.
- [x] Link the stack to `/settings/teams/:teamSlug/members`.
- [x] Show `Full name (username)` through the design-system tooltip.
- [x] Cover the five-avatar cap, overflow, destination, and tooltip interaction with focused tests.
- [ ] Capture the authenticated table and tooltip states.
- [ ] Complete the browser-rendered focused comparison.

### Latest comparison history

1. Source inspection: the supplied references establish 24 px circular avatars, compact overlap, a `+N` overflow item, and a dark identity tooltip.
2. Implementation: replaced numeric metadata with a linked avatar stack and added real server-backed member previews.
3. Verification attempt: local route redirected to sign-in, so no implementation screenshot or valid side-by-side comparison could be produced.
4. Alignment refinement: the latest crop establishes shared left edges beneath Membership, Members, and Active projects. Preserved the matching 112 px, 128 px, and 128 px column tracks and added equal-height flex alignment wrappers across every row cell.

final result: blocked

---

## Comparison target

- Source visual truth: `/Users/matthieu/Projects/forge-app/forge-app/docs/audits/workspace-teams-linear-reference.png`
- Rendered implementation: `/Users/matthieu/Projects/forge-app/forge-app/docs/audits/workspace-teams-implementation.png`
- Open-menu evidence: `/Users/matthieu/Projects/forge-app/forge-app/docs/audits/workspace-teams-menu.png`
- Side-by-side comparison: `/Users/matthieu/Projects/forge-app/forge-app/docs/audits/workspace-teams-comparison.png`
- State: dark desktop workspace, two joined teams, compact rows; both closed and open team-menu states checked.
- Source pixels: 1224 × 768.
- Implementation pixels: 1224 × 768.
- CSS viewport: 1224 × 768.
- Density normalization: equal pixel dimensions and matching viewport; no resampling was needed before the side-by-side comparison.

## Interaction verification

- Opened the team filter and selected `Joined teams`.
- Opened display options and verified name/member ordering plus compact/comfortable density choices.
- Opened a team action menu and verified Favorite, settings, Copy URL, archive, subscription, Slack notifications, and leave actions.
- Verified create-team and team-project destinations expose stable links.
- Checked the final browser console after a fresh render and interaction pass; no warnings or errors remained.

## Required fidelity surfaces

- Fonts and typography: passed. Forge retains its existing Geist typography with clear 12 px table labels, medium team names, muted identifiers, and restrained hierarchy.
- Spacing and layout rhythm: passed. The 48 px page header, count/action row, full-width table, 32 px header, and 40 px compact team rows maintain a clear desktop rhythm.
- Colors and visual tokens: passed. Background, row hover, divider, badge, muted foreground, focus, and menu colors use Forge's dark-theme tokens and stay visually aligned with the reference.
- Image quality and asset fidelity: passed. The source contains no bespoke raster imagery. Team marks use persisted team icons and all interface symbols use the project's Hugeicons library.
- Copy and content: passed. Name, Membership, Members, and Active projects appear in the same order; team names, identifiers, Joined badges, and contextual menu copy match the reference structure.
- Responsiveness and accessibility: passed. Lower-priority columns collapse progressively, every icon-only control has an accessible name, table semantics are preserved, menus are keyboard-backed Base UI primitives, and focus styles remain visible.

## Full-view comparison evidence

The equal-size side-by-side capture shows the same narrow left navigation relationship, compact title row, two-team count, top-right filter/display controls, edge-to-edge four-column table, dense team rows, and large negative-space composition. Forge intentionally retains its own sidebar content rather than copying Linear's product shell wholesale.

## Focused region comparison evidence

The team table and open row-menu states were inspected at full 1224 × 768 resolution. Column alignment, row height, identifiers, Joined badges, member/project metadata, hover action placement, menu width, separators, and destructive leave treatment are all legible at 1:1 scale, so a separate enlarged crop was not needed.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] Forge keeps a slightly roomier row-action menu than Linear. This is intentional alignment with the existing Forge component system.

## Comparison history

1. Initial visual pass: P2 compact-row density mismatch.
   - Evidence: the first implementation rendered 40 px compact rows while the 1224 × 768 Linear source uses approximately 32 px rows.
   - Fix: reduced compact rows to 32 px, kept 44 px as the explicit comfortable option, and tightened the filter/display buttons to 24 px.
   - Post-fix evidence: `workspace-teams-comparison.png` shows matching two-row density and table height.
2. Interaction pass: P2 link-button semantics warning.
   - Evidence: the browser console reported that create-team links rendered through the Button primitive still declared native-button behavior.
   - Fix: marked both link-backed create-team buttons with `nativeButton={false}`.
   - Post-fix evidence: a fresh final browser tab rendered the closed and open-menu states with an empty warning/error console.
3. User refinement: remove the card-like table treatment.
   - Evidence: the table still had an outer border, rounded corners, and horizontal page gutters.
   - Fix: removed the outer border and radius, stretched the populated table to the full content-pane width, and retained gutters only for the count and controls.
4. User refinement: strengthen and align table labels.
   - Evidence: 11 px column labels felt too small, and the Name column started 4 px left of the team counter.
   - Fix: increased visible column labels to 12 px and aligned the Name header and team rows to the counter's 16 px left gutter.
5. User refinement: increase row height and soften hover.
   - Evidence: the 32 px team rows felt too compressed and the rectangular hover treatment was too rigid.
   - Fix: increased compact rows to 40 px and comfortable rows to 48 px, then applied the hover surface to individual cells with rounded outer corners.
6. User refinement: inset the row surface without shifting content.
   - Evidence: the rounded hover surface still reached the table edges.
   - Fix: added 4 px transparent outer gutters to the first and last cells and reduced their corresponding inner padding by 4 px, preserving the existing content alignment.

## Implementation checklist

- [x] Compact workspace team directory
- [x] Real membership and member-count data
- [x] Joined-team filtering and team ordering
- [x] Compact and comfortable row densities
- [x] Team-level settings and contextual actions
- [x] Responsive column collapse
- [x] Empty and permission-aware states
- [x] Browser interaction and console verification

## Follow-up polish

- None required for this pass.

final result: passed
---

# Agent history design QA

## Comparison target

- Source visual truth: `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/com.openai.sky.CUAService/Linear Screenshot 2026-07-24 at 5.05.37 PM.jpeg`
- Rendered implementation: `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-07-24 at 5.05.38 PM.jpeg`
- State: desktop app, history open, populated history, light theme in Forge and dark theme in the Linear source.
- Source pixels: 1224 × 768.
- Implementation pixels: 1224 × 768.
- CSS viewport: matching 1224 × 768 app windows.
- Density normalization: equal pixel dimensions; both full-resolution captures were emitted together in the same comparison pass.

## Interaction verification

- Opened and closed history from the persistent footer action.
- Entered `profile` in the history search and confirmed the list filtered to the matching conversation.
- Cleared the search and confirmed the complete list returned.
- Existing coverage verifies selecting a history item reopens the conversation and preserves its transcript.

## Required fidelity surfaces

- Fonts and typography: Forge retains its existing app font and tokenized weights. Search text, group labels, row titles, and timestamps match the compact hierarchy of the source without uppercase transformation.
- Spacing and layout rhythm: the history panel shares the chat bottom edge. Its visible width and height closely match the source, while 28 px rounded rows produce the requested denser list.
- Colors and visual tokens: all foreground, muted, border, selection, failure, background, and shadow colors use Forge design-system tokens. Theme differences between the source and implementation are intentional.
- Image quality and asset fidelity: the history panel has no bespoke raster assets. Existing Hugeicons are retained only for hover actions and active failure/running states.
- Copy and content: the search placeholder is `Chat history`; date groups use sentence case; relative timestamps follow the source format.

## Full-view comparison evidence

The equal-size captures show the same bottom-right placement, compact panel proportions, integrated search header, dense grouped list, right-aligned timestamps, and persistent footer relationship. Forge intentionally keeps its own sidebar and page shell.

## Focused region comparison evidence

The bottom-right history regions were inspected at full screenshot resolution. The source panel is approximately 288 px wide and 325 px tall; Forge renders at approximately the same visible width and height. The search header, group labels, selected pill, row spacing, truncation, and timestamp alignment remain legible at this scale, so a separate enlarged crop was not needed.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] Forge uses its established fully rounded selected row and 16 px panel radius rather than Linear's subtler selection and tighter outer corners. This is intentional design-system alignment requested by the user.

## Comparison history

1. Initial pass: P2 placement and density mismatch.
   - Evidence: the old toolbar consumed vertical space, the panel sat 40 px above the chat edge, labels were uppercase, and rows were 40 px tall.
   - Fix: removed the toolbar, moved search into the header, anchored the panel at `bottom: 0`, removed uppercase styling, and reduced rows to 28 px.
2. Second pass: P2 proportion and search-treatment mismatch.
   - Evidence: the panel was narrower and shorter than the source; the search appeared as an inset pill with a leading icon; neutral status dots added visual noise.
   - Fix: matched the reference proportions, integrated the search field into the panel header, removed its icon, and reserved indicators for running, failed, or archived states.
   - Post-fix evidence: the final equal-size captures show aligned bottom placement, nearly identical panel proportions, a clean search header, compact rounded rows, and source-like list density.

## Implementation checklist

- [x] Bottom-anchored desktop history panel
- [x] Search-only header matching the reference structure
- [x] Compact fully rounded history rows
- [x] Sentence-case date labels
- [x] Right-aligned relative timestamps
- [x] Working search, open, rename, archive, and reopen behaviors
- [x] Responsive mobile sheet retained
- [x] Regression coverage for placement, search, and row styling

## Follow-up polish

- None required for this pass.

final result: passed

---

# Billing settings design QA

## Comparison target

- Source visual truth: user-provided Linear Billing settings reference in the current conversation (1536 × 955 px).
- Rendered implementation: `/Users/matthieu/Projects/forge-app/forge-app/docs/audits/billing-implementation.png`.
- Responsive evidence: `/Users/matthieu/Projects/forge-app/forge-app/docs/audits/billing-implementation-mobile.png`.
- State: dark theme, Free plan current, upgrade offer visible, no invoices, all overlays closed.
- Source pixels: 1536 × 955.
- Implementation pixels: 1536 × 955.
- CSS viewport: 1536 × 955 with `devicePixelRatio: 1`; responsive check at 390 × 844.
- Density normalization: equal pixel dimensions for the desktop comparison.

## Interaction verification

- Opened the Manage menu and verified each plan action is available.
- Opened and closed the Basic plan dialog from the page action and from Manage.
- Opened the AI usage and credits dialog.
- Checked the final browser console after the interaction pass; no warnings or errors remained.

## Required fidelity surfaces

- Fonts and typography: passed. The page uses Forge's existing Geist typography with the compact weight and scale hierarchy visible in the source.
- Spacing and layout rhythm: passed. The centered 640 px settings column, inset heading alignment, compact plan cards, feature grid, credits row, and invoice section retain the source rhythm while matching surrounding Forge settings pages.
- Colors and visual tokens: passed. Surfaces, borders, muted text, focus rings, and hover states use Forge tokens; the Basic upgrade action and feature checks preserve the reference's indigo accent.
- Image quality and asset fidelity: passed. The source contains no raster imagery. All interface icons use the project's existing Hugeicons library.
- Copy and content: passed. Current plan, user count, pricing, plan features, credit balance, and empty invoice state match the supplied reference.
- Responsiveness and accessibility: passed. The feature grid collapses cleanly at 390 px, controls wrap without clipping, headings are hierarchical, and all actions have accessible names and visible focus treatment.

## Full-view comparison evidence

The equal-size desktop review shows the same restrained dark surface, centered billing column, title/subtitle/all-plans header, three-card billing stack, compact feature matrix, and separated invoice empty state. The existing settings sidebar and desktop shell were reused rather than reimplemented.

## Focused region comparison evidence

The plan stack was inspected at full resolution. The Free plan row, Basic plan header and feature grid, credit balance row, and recent invoices card remain legible without an enlarged crop. The responsive capture confirms the same hierarchy at a narrow viewport.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] Forge retains its existing 16 px settings-card radius, which is slightly rounder than the Linear reference and intentionally keeps this page consistent with the rest of the product.

## Comparison history

1. Initial pass: P2 card density and feature-icon mismatch.
   - Evidence: the Free plan, AI credits, and invoice rows were taller than the source, the Basic plan card was too loose, and feature checks appeared inside circles.
   - Fix: tightened row heights and card padding, reduced feature-grid gaps, aligned the page with the established settings top spacing, and switched to simple indigo checks.
2. Interaction pass: P1 Manage menu crash.
   - Evidence: opening Manage raised a Base UI missing group-context error and cleared the rendered page.
   - Fix: wrapped the labeled menu items in the existing `DropdownMenuGroup` primitive and delayed the dialog transition until after menu close.
   - Post-fix evidence: Manage, plan details, upgrade, and credits flows all opened correctly with an empty final browser console.

## Implementation checklist

- [x] Billing route and active sidebar destination
- [x] Current Free plan summary and Manage menu
- [x] Basic plan upgrade offer and complete feature set
- [x] AI usage and credits drill-in
- [x] Recent invoices empty state
- [x] Desktop-tab Billing icon and breadcrumb
- [x] Desktop and mobile visual checks
- [x] Focused component and navigation regression coverage

## Follow-up polish

- None required for this pass.

final result: passed

---

# Security settings design QA

## Source

- Supplied Linear Security settings references covering the top, middle, and lower scroll states.
- Compared against the production build at a desktop viewport in both light and dark appearance.

## Comparison

- Layout: Passed. The page uses the existing Forge settings shell, centered settings column, section hierarchy, card grouping, and scrolling behavior shown in the reference.
- Typography: Passed. Headings, row labels, descriptions, plan labels, and link treatments follow the existing Geist-based settings typography.
- Surfaces: Passed. Cards, dividers, controls, radii, and dark-mode contrast match the surrounding settings pages and supplied reference.
- Content: Passed. All referenced Security sections and rows are present in the same order.
- Interactions: Passed. Invite-link enable/copy/reset, authentication and agent switches, permission menus, and approved-domain add/remove behavior work and persist locally.
- Responsive behavior: Passed. Rows reflow cleanly on narrow screens while retaining the desktop reference layout at the target size.
- Accessibility: Passed. Interactive controls have accessible names, headings are hierarchical, and the domain form exposes validation state.

## Remaining issues

- None at P0, P1, P2, or P3.

final result: passed

---

# Model selector design QA

- Source visual truth: `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/codex-clipboard-c680f1b0-2d80-4394-b0ae-ac6f756c5f1d.png`
- Implementation evidence: inline Computer Use capture of the running Electron app at `http://localhost:3000/forge`, 2026-09-17
- Viewport: Electron window, 1224 x 768 screenshot; selector rendered at its 256px responsive maximum width
- Source pixels: 510 x 190; density metadata unavailable
- Implementation pixels: full-window 1224 x 768 capture; focused selector compared in place
- CSS size and normalization: the source is an isolated component crop while the implementation is an in-product capture. The comparison normalized by component proportions and interaction state rather than assuming an unknown source density.
- State: GPT 5.6 Sol, Medium effort, model selector open, light product theme

## Full-view comparison evidence

The implementation preserves the reference hierarchy: lightning icon on the left, centered effort with a forward affordance, model name directly beneath, reset on the right, and a single full-width segmented slider below. The selector remains anchored to the composer and does not obscure its send or attachment actions.

## Focused region comparison evidence

A focused comparison was necessary because the selector occupies a small part of the full app capture. The focused review checked the header alignment, large pill track, blue selected range, white thumb, evenly spaced markers, corner radius, and spacing between the header and track.

## Required fidelity surfaces

- Fonts and typography: Geist is retained to match the product. Size, weight, hierarchy, truncation, and line height follow the reference composition; the effort is the most prominent label and the model is secondary.
- Spacing and layout rhythm: the three-column header, centered labels, large-radius container, and full-width track match the reference proportions. Responsive width is capped and constrained to the viewport.
- Colors and visual tokens: blue communicates the active range and selected effort. Background, border, and muted colors intentionally use the current Forge theme instead of forcing the reference's dark theme.
- Image quality and asset fidelity: no raster assets are present. Lightning, chevron, and reset use the project's Hugeicons library rather than approximated glyphs.
- Copy and content: the live effort and model names match product state. Reset has an explicit accessible label and tooltip.

## Comparison history

### Pass 1

- [P1] The slider track rendered as a thin line because the shared slider's horizontal height selector overrode the local height.
- Fix: applied the height through the component's horizontal-state selector so the track becomes the large pill shown in the reference.

### Pass 2

- Post-fix evidence: the Electron capture shows the full-height blue/gray pill, white thumb, centered Medium label, GPT 5.6 Sol subtitle, and working reset action.

### Pass 3

- [P1] The first full-height implementation treated the reference pixels as CSS pixels, making the selector, track, thumb, and icons visibly oversized in the composer.
- Fix: normalized the reference as an approximately 2x-density crop, reducing the popover from 320px to 256px, the track from 48px to 24px, the thumb from 44px to 28px, and the supporting icons and type proportionally.
- Post-fix evidence: the Electron capture shows the compact selector aligned with the composer controls while retaining the reference hierarchy and stepped-slider interaction.

### Pass 4

- [P2] The compact card still gave the effort label more visual weight than intended.
- Fix: reduced the effort label from 16px to 14px without changing the model label or slider geometry.
- Post-fix evidence: the latest Electron capture shows a quieter header hierarchy with the effort label still readable and primary.
- No actionable P0, P1, or P2 differences remain.

## Findings

No blocking fidelity issues remain. The light surface is an intentional adaptation to the active Forge theme.

## Follow-up polish

- [P3] A separate dark-theme capture could confirm the exact tonal match to the supplied dark reference.

## Implementation checklist

- [x] Reference composition reproduced in the existing picker.
- [x] Slider supports pointer and keyboard interaction.
- [x] Current value and reset state update immediately.
- [x] Advanced model/provider navigation remains available.
- [x] Focused, full, type, lint, and formatting checks pass.

final result: passed


## Team label selection and inline editing — October 11, 2026

- Saved rows retain inline name/description editors, a separate color picker, selection checkbox, and trailing edit/delete menu after reload. Hover corners remain 8 px with the expanded row width.
- Selected rows form a continuous purple block. A bottom floating bar opens a searchable keyboard-accessible command menu with Favorite, Move to workspace, Merge, Archive, and Delete. Escape restores focus to Actions and retains selection; Clear selected dismisses the bar.
- Favorite/archive metadata remains backward compatible with existing saved labels. Archive recovery uses the Archived labels filter. Workspace moves preserve labels in a shared browser-local workspace view; a failed source write rolls back the destination copy. Merge and deletion offer Undo without replacing unrelated later edits. These actions remain browser-local; no server label CRUD or live issue associations were added.
- Verified the authenticated Testing route at the normal desktop viewport and at 390 × 844. The mobile command popup stays within the viewport, and the table scrolls without widening the document.
- Evidence: `labels-floating-selection-bar.png`, `labels-selection-command-menu.png`, and `labels-selection-mobile.png` under `/Users/matthieu/.codex/visualizations/2026/10/10/01a1261a-7373-7dd0-915d-bf2cdd1b43ca/`. Temporary QA labels are removed after verification.
- Validation: 24 focused label tests, app typecheck, targeted ESLint, production build, and `git diff --check`.

## Team templates — October 11, 2026

- Implemented the supplied team-template overview, issue-type chooser, standard issue and custom-form editors, project template editor, and document template editor inside the existing settings shell. Overview uses a 640px column; editors use a wider 750px column with compact property pills and nested cards. Active Forge theme tokens are retained with the reference purple save action.
- Template creation, editing, duplication, deletion, and separate member/non-member default selections persist in Neon. An additive migration creates the template/default tables. Server mutations derive workspace/team/creator from the session, enforce management roles and scopes, validate related teams/people, and reject stale revisions. Reads use the complete accessible-team directory, including private-team filtering.
- Rich descriptions support searched slash commands, headings, lists, checked tasks, code blocks, Mermaid source/preview, collapsible sections, quotes, colored callouts with icon/emoji selection, images, and downloadable/media attachments. Selection formatting includes links. Icon pickers have searchable Icons and Emojis tabs; non-team pickers also accept custom colors.
- Project milestones and issues support creation/editing/removal, issue duplication, assignee selection, standard-template application, and create-more. Standard issue templates support sub-issues. Forms support six field types, required flags, dropdown options, reordering, removal, and editable preview. Property hotkeys, save/add shortcuts, searchable keyboard menus, and unsaved-draft protection are implemented.
- Authenticated Electron verification reached the Testing templates route, document editor, slash-command states, searchable emoji picker and rocket callout, checked task list, actual Mermaid SVG preview, save, and reopening the saved document. Task-row alignment and attachment-node insertion were corrected during QA. Save/reopen preserved emoji, checked tasks, and diagram source.
- Automated checks cover advanced-block JSON round trips, image/file insertion, slash filtering and Enter selection, property hotkeys, multi-selection, consecutive create-more issues, milestone draft cancellation, form reorder/preview, validation, revision conflicts, and access boundaries. Full app suite: 503 tests and 4 workflow tests passed. Typecheck, targeted lint, production build including protected Workflow handler verification, and diff checks pass.
- Limits: project/initiative/issue product domains are currently placeholders elsewhere in Forge, so related pickers show honest empty states rather than fabricated associations. Labels reuse the existing browser-local label directory. Attachments are embedded in template JSON (4 MB per file; 8 MB total payload) rather than uploaded to an object store.
- Resumed authenticated Electron verification after unlocking the Mac: project status/priority/lead/member search and keyboard selection; milestone creation/editing; consecutive create-more issues; nested duplication/removal; standard sub-issue save/reopen; standard-template application in the project issue composer; form field types/options/required flags/reordering/interactive preview/save/reopen; and member/non-member default eligibility. Saved project properties, milestones, issues, and sub-issues survived reopening. Corrected the wrapping Issues pill and singular member/label copy during these checks.
- Native file chooser inserted a repository PNG into a document; save/reopen retained the image, code block, quote, collapsed section, and its hidden content. Discard protection also worked after changing the expansion state. Temporary QA templates were removed by their exact IDs, and the original default selection was restored to None. Private-team exclusion remains verified through server tests, not a second authenticated desktop account. Final validation after the layout correction: 21 focused tests, typecheck, targeted lint, production build, and diff check passed.

## Shared icon and emoji picker — October 11, 2026

- Reduced the popover from 412px to 320px, the scroll area from 288px to 240px, and color dots from 24px to 18px with an 8px gap. Tabs now sit together at the left; both grids use 12 responsive columns.
- Fixed catalog pagination: 168 initial entries overflow the compact scroll area, scrolling adds further pages, and explicit Show more buttons provide a keyboard-accessible fallback. Search filters the complete installed Hugeicons catalog before pagination.
- Emoji data now includes all 3,979 Unicode entries from the installed Emojibase dataset, including nested skin-tone variants and components. Search accepts Unicode, names, tags, and shortcode aliases.
- Authenticated Electron verification confirmed the compact palette, icon pagination growing from 169 to 337 rendered grid items including the fallback button, a Zzz icon search, emoji pagination, all six waving-hand variants, and Unicode search. Existing team settings were retained.
- Validation: 15 focused picker/editor/control tests, app typecheck, targeted ESLint, production build with protected Workflow handler verification, and diff checks passed.

## Team issue statuses — 2026-10-11

- Reference: the five supplied Linear issue-status screenshots. Retained Forge's settings shell, theme tokens and typography; implemented a centered 640 px card with six workflow groups, tinted status icons, compact rows, inline creation/editing, a color palette/custom hex editor, and row menus.
- Route: `/settings/teams/$teamSlug/statuses`, linked from the team's workflow settings and named in the app breadcrumbs.
- Browser evidence (isolated production component preview): `.forge/status-qa/desktop.png`, `color.png`, `menu.png`, `mobile.png`, `mobile-color.png`, and `light-mobile.png`. Desktop viewport 1440 × 1000, mobile 390 × 844, DPR 1. These verify the page component, not the surrounding authenticated shell. The reference's full desktop-app pixels were not treated as CSS pixels.
- Verified in Chromium: creation, editing, preset/custom colors, default selection, persistence after reload, deletion/Undo, menu-based reordering, native drag reordering within a group, focused editor entry, Escape/cancel focus return, nested popover Escape, dark/light rendering, mobile editor and color picker, and no mobile document overflow. Reduced-motion styling is present; a full slow-motion animation audit and physical touch-device testing were not performed.
- Five component/data tests cover duplicate names, trimmed names, cancel, remount persistence, default/last-status protection, corrupt-data preservation, failed-save draft retention, team isolation, and persisted workflow invariants. Routing/navigation suites also pass (24 tests total).
- Typecheck, targeted ESLint, production build and diff whitespace checks passed. The authenticated application route redirects an unauthenticated browser to login with the intended return URL; authenticated end-to-end navigation remains unverified.
- Storage scope: versioned, validated local storage per team, consistent with team labels. No server workflow CRUD, live issue counts, or issue reassignment integration exists yet. Duplicate is fixed; default statuses and the final status in a group cannot be deleted. Corrupt saved data is preserved with editing disabled.

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| Resolved | Status editor | Replacing a row detached its original menu trigger | Restore focus to the mounted trigger after save/cancel | Preserve keyboard continuity |

No actionable UI-polish findings in inspected states. Approve for the verified component scope; authenticated shell and physical touch-device behavior remain unverified.


## Team recurring issues — 2026-10-11

Implemented the reference list and new/edit editor at `/settings/teams/$teamSlug/recurring-issues`. The team overview links to the list. Schedules are persisted in the database with actor-derived workspace/team authorization, owner/admin writes, validation and optimistic revision protection. Migration 0021 creates the schedule table; 0022 restricts timestamps to millisecond precision so database defaults round-trip through JavaScript Dates without false stale-save conflicts.

Authenticated browser QA used the Testing team at 1800×1130 and 390×844. Verified empty/new pages, title validation, checklist slash command, Todo/High/assignee menus, searchable emoji selection, sub-issue creation, save/reopen of rich content and properties, date changes to October 21 and a three-month cadence, unsaved-change Keep editing/Discard, and delete confirmation/cancel. The temporary QA record was removed after verification. Both mobile editor and list measured document width 390px at a 390px viewport. The 320px icon picker fits and reopens its selected emoji tab; tabs now use controlled state to avoid Base UI default-value warnings.

Evidence: `docs/audits/recurring-issues/desktop-empty.png`, `desktop-new.png`, `desktop-edit.png`, `desktop-list.png`, `mobile-list.png`, `mobile-picker.png`.

Validation: nine targeted suites / 41 tests passed, including calendar validity, team timezone defaults, permissions, foreign workspace/team/member rejection, stale-save/delete handling and timestamp precision. Production build and Workflow handler verification passed; scoped ESLint, TypeScript and diff whitespace checks passed. React review checked module-level components, lazy draft initialization, synchronous event capture, cleanup of keyboard listeners, duplicate-save prevention and disabled/read-only controls.

Boundary: this is saved schedule configuration and UI. Forge issue routes still use placeholders; there is no issue instance scheduler or automatic issue creation yet. Desktop Electron displayed a blank surface, so authenticated rendered verification used the in-app browser. A pre-existing TanStack devtools runtime warning was observed, with no recurring-issue UI failure.

## Team workflows and automations — 2026-10-12

- Reference: the two supplied Linear screenshots, covering PR automations, branch-specific rules, parent/sub-issue/stale auto-close settings, automatic archiving, and issue ordering. Uses Forge's existing settings shell, 640 px content width, typography, theme tokens, Select, Switch, and Dialog controls. The status glyph is now shared with Issue statuses.
- Route: `/settings/teams/$teamSlug/workflows`; connected to the Workflow card in the team overview and the app breadcrumb. The overview's current team slug is passed through. A router integration test clicks the overview link and renders the actual workflows component for a non-default team slug.
- Browser evidence: `.forge/workflows-qa/desktop.png`, `desktop-lower.png`, `mobile.png`, `mobile-menu.png`, `mobile-lower.png`, and `mobile-light.png`. Isolated component preview at 1440 × 1100 and 390 × 844, DPR 1. The complete authenticated settings shell was not captured; full app authentication remains unverified.
- Verified in Chromium: all PR selectors (including No action), branch creation/rename/independent overrides/removal/Undo, parent and child switches, stale switch and dependent controls, duration selectors, ordering, reload persistence, focused branch input, Escape returning focus from a select, light theme and reduced-motion mode. No browser page errors or document/main horizontal overflow.
- Targeted suites passed: 31 tests covering workflows, statuses, overview navigation, route hierarchy, and breadcrumbs. Includes corrupt-data preservation, persistence failure behavior, team isolation, renamed/removed status references, branch duplication, and default rule copying. Typecheck, targeted ESLint, production build, and diff whitespace checks passed.
- Persistence is versioned local storage per team, matching Issue statuses. These controls configure the UI; GitHub webhooks and automatic changes to issues, cycles, and projects are not implemented. The sole canceled status remains disabled in the stale-status selector, matching the reference; teams with multiple canceled statuses can select one.
- No actionable UI-polish findings in inspected states. Approve for the verified component scope. Full authenticated navigation, physical touch-device behavior, and slow-motion animation inspection remain unverified.

### Add branch refinement — 2026-10-12

- Replaced the branch dialog with the supplied reference's inline card: branch icon, focused `branch name` input, Use regex checkbox, cancel and submit icon buttons. Add branch is visibly disabled while an editor is open. The same inline editor preserves matching mode when editing a saved rule.
- Added persisted `useRegex` with a false default for older saved branches. Regex mode validates syntax before saving; literal names retain their existing validation. Duplicate checks and removal/Undo distinguish literal from regex patterns.
- At 390 px, actions wrap onto a second line so the input remains usable. Browser evidence: `.forge/workflows-qa/inline-branch-desktop.png` and `inline-branch-mobile.png`.
- Chromium verified initial focus, disabled Add branch, absence of a modal, invalid-regex errors, Enter to submit, reload persistence, editing with the saved regex checkbox, Escape/cancel, and focus restoration. No browser errors or horizontal overflow. Seven workflow tests plus two overview navigation tests pass; typecheck and targeted lint pass. Verification is still an isolated component preview rather than the authenticated shell.

### Fixed team navigation — 2026-10-12

- Moved the workflows page's team navigation outside the content scroll pane. The header retains its 48 px height; only settings content scrolls.
- Chromium verification at 1440 × 900 and 390 × 844: scrolled settings to the bottom (710 px / 1338 px), team link stayed at y=10 px, document scroll remained 0, and the final settings section was visible. Evidence: `.forge/workflows-qa/fixed-team-1440.png` and `fixed-team-390.png`. Targeted lint, typecheck and diff checks passed.

## Team triage — 2026-10-12

- Implemented `/settings/teams/$teamSlug/triage` from the supplied Linear reference: triage switches, responsibility/trial card, Loops row, and dimmed Triage Intelligence section. Uses existing Forge components and theme tokens. The overview links to Triage and shows the saved On/Off state; desktop breadcrumb names the page.
- The team navigation is outside the scroll pane. Chromium verified desktop 1440×900 and mobile 390×844: stable header position, document scroll 0, final section visible, and no horizontal document overflow. Visually inspected desktop 1440×1100 and mobile top/bottom captures. Light/reduced-motion capture also generated.
- Verified toggle dependency, preference retention when triage is disabled, persistence after reload, availability dialogs, and billing/AI/documentation link targets. No browser page errors. Evidence in ignored `.forge/triage-qa/`: `desktop.png`, `enabled.png`, `mobile.png`, `mobile-lower.png`, `light-mobile.png`.
- Four targeted suites / 26 tests passed, including triage persistence/error handling/team isolation, overview navigation to the actual component, route hierarchy, and navigation helpers. Typecheck, scoped ESLint, production build including protected Workflow handler verification, and diff whitespace checks passed.
- Scope: per-team local settings only; no server triage intake/prioritization enforcement. Business trials, sales contact, and triage Loops are unavailable and their controls explain this without pretending to activate a service. Billing and AI link to existing settings routes. Browser verification used an isolated preview of the real component; full authenticated shell navigation and physical touch-device behavior remain unverified.

## Team cycles — 2026-10-12

- Implemented `/settings/teams/$teamSlug/cycles` from the supplied enabled/disabled references, retaining the settings shell, fixed team header, theme tokens and 640 px card width. The team overview links to Cycles and reflects its saved On/Off state.
- Enable cycles reveals duration, cooldown, weekday and future-cycle selectors. Disabling preserves selections and disables/dims automation controls. Start-date text is calculated from the next selected weekday. Preferences use validated, versioned browser-local storage per team; corrupt saved data is preserved and editing disabled, and failed writes retain the previous value with an error toast.
- Authenticated Testing-team browser verification: default disabled state, enabling, all four selectors, weekday/date updates, automation preference changes, reload persistence, keyboard Space/Enter/Escape and restored selector focus, overview/back navigation and Off state. Desktop at 1800 × 1130 and mobile at 390 × 844. The mobile document and both main elements measured 390 px wide; weekday menu stays within the viewport. Original default values restored after QA.
- Evidence: `.forge/cycles-qa/desktop-enabled.png`, `desktop-disabled.png`, and `mobile-menu.png`. No actionable UI-polish findings in inspected states. Approve for verified scope; physical touch devices, light theme and slow-motion inspection were not verified. Reduced-motion overrides were checked in source.
- Validation: 27 focused tests passed (cycles, overview navigation, route hierarchy and navigation labels), app typecheck, targeted ESLint, production build including Workflow handler verification, and diff whitespace check. React review covered module-level components, effect cleanup, validated storage, accessible labels/descriptions and disabled controls.
- Scope: settings UI and browser-local preferences. No cycle scheduler, server persistence, issue movement, carryover or velocity metrics are implemented.

## Team agents empty state — 2026-10-12

- Created `/settings/teams/$teamSlug/agents` with the reference title, exact description, Docs link and single integration empty-state card. Reuses the fixed team header, centered 640 px card width and existing theme tokens. Linked Team agents from the overview and added its navigation label.
- Authenticated Testing-team verification: desktop 1280 × 720, mobile 390 × 844, back/overview navigation and integrations action. Mobile document width is 390 px. Evidence: `.forge/team-agents-qa/desktop.png` and `mobile.png`.
- Integrations remains an existing unimplemented settings destination, so the inline action displays “Agent integrations are coming soon.” No agent list, configuration, or backend changes were added. The Docs link uses the exact supplied reference destination.
- Typecheck, scoped ESLint, 23 existing navigation/overview/routing tests, production build with Workflow verification, and diff whitespace checks passed. No new tests added for this static empty state. No actionable UI-polish findings in inspected states; light theme and physical touch devices not verified.
