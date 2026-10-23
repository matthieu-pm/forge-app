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

## Integrations settings — 2026-10-12

- Added the protected `/settings/integrations` route, Features sidebar destination, and Integrations breadcrumb while preserving the existing Forge settings shell.
- Matched the supplied Linear catalog structure with a centered 720px column, 48px search control, enabled carousel, featured integration panel and tabs, responsive three-column category cards, expandable categories, and one-column mobile layout.
- Search, featured-tab switching, enabled-card management links, catalog expansion, and detail dialogs are wired. Disabled integrations state clearly that connection setup is unavailable and do not perform external account changes.
- Replaced generic glyphs with 56 locally stored brand assets. Full-color vectors come from the SVG Logos collection where available; Simple Icons supplies additional optimized brand vectors; small remaining brands use downloaded official-site favicons. SVGs were processed with multipass SVGO and raster fallbacks were resized to 64px. The complete local logo set is 122,560 bytes and all 56 files return HTTP 200 from the preview server.
- Rendered verification covered the desktop layout, the 390×844 mobile layout, filtering, dialogs, featured tabs, and real-logo rendering. A fresh browser session reported no warnings or errors.
- Five focused component tests, targeted ESLint, full TypeScript, production build with protected Workflow handler verification, route HTTP 200, and `git diff --check` pass.

final result: passed

## Project updates settings — 2026-10-12

Source visual truth: the three supplied Linear attachments named `Linear Appshot 2026-10-12T17-06-44.938Z.png`, `Linear Appshot 2026-10-12T17-06-59.112Z.png`, and `Linear Appshot 2026-10-12T17-07-08.620Z.png`, plus the three supplied dark-mode mockups for read, edit, and open-menu states. Source attachments were displayed at 1987 × 1248 after conversation resizing. Implementation evidence: Codex in-app Browser captures of `http://127.0.0.1:4319/` in this thread at the default 1280 × 720 CSS viewport and at 390 × 844 CSS pixels. The implementation used device scale 1. The focused comparisons covered the update-schedule card, schedule menu, Slack row, and narrow edit state.

**Findings and comparison history**
- [P2, resolved] The first narrow-screen edit layout put the 210px schedule control and both action buttons on one row. This was too dense and risked overflow. The edit card now wraps to a full-width selector and right-aligned action row below 640px; the 390 × 844 post-fix capture showed no horizontal overflow.
- No actionable P0/P1/P2 desktop differences remain. The implementation preserves the reference's centered 688px content column, title and helper hierarchy, 56px schedule surface, 72px Slack surface, section rhythm, rounded menus, selected option indicator, and read/edit/open states inside the existing Forge theme.
- [P3, accepted] Forge's existing Geist type and neutral component tokens differ slightly from Linear's surrounding shell and active button tint. Existing product tokens and reusable controls were retained intentionally.

**Required fidelity surfaces**
- Fonts and typography: existing Forge Geist; 24px page heading, 14px section and helper copy, compact 12px secondary row copy, and reference line wrapping verified.
- Spacing and layout rhythm: 688px desktop content width, responsive 20px page gutters, 36px first-section spacing, 48px section gap, compact card heights, and menu width verified.
- Colors and visual tokens: existing dark Forge background, muted cards, foreground hierarchy, emerald connection dot, and product focus styles retained.
- Image quality and assets: no raster imagery was required. Slack, information, dropdown, and selected-state marks use existing icon-library components; no placeholder art was added.
- Copy and content: reference title, descriptions, channel name, cadence options, action labels, and documentation URL retained.

**Interactions and checks**
- Edit, Cancel, nine-option schedule menu, Save, workspace-scoped persistence, reload persistence, and Slack management menu were verified in the in-app Browser. The clean final browser run reported no console errors.
- Four focused tests cover initial content, editing/cancel, cadence save, and workspace isolation. Targeted ESLint, full TypeScript, production build with protected Workflow verification, and repository whitespace checks passed.
- The Slack row mirrors the supplied connected state and routes management to the existing Applications settings page; no new Slack backend or credential flow was invented.

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

## Team agent skills — 2026-10-12

- Added `/settings/teams/$teamSlug/agent-skills`, `/new`, and `/$skillId` with the supplied empty/list/editor/menu composition, fixed team navigation and 640 px content cards. The team overview links to Agent skills; navigation titles distinguish list, new and edit pages. Product copy uses Forge Agent.
- Create/edit validates required names and instructions; editor supports multiline instructions, initial name focus, explicit cancel/save and unsaved-change protection. Menus expose Edit, Move to team, Copy link, Use in chat and Delete. Move uses the authenticated accessible-team directory; deletion requires a dialog. Use in chat appends instructions to the current draft and opens the composer without sending.
- Versioned, validated browser-local persistence stores skills with team IDs and revisions. Changes read the latest collection before writing, preserve unrelated records and reject stale edits/moves/deletes. Invalid saved data is retained and editing disabled. This is local to the browser, not shared server storage; copied URLs resolve only where the skill data exists.
- Authenticated Testing-team QA at 1280 × 720 and 390 × 844: empty state, create validation, creation, menu layout, edit/save/reload, copied URL, unsaved Keep editing/Discard, chat insertion, delete Cancel/confirm, and overview/back navigation. Mobile document width equals 390 px. Only one accessible team exists, so the No other teams submenu was inspected; cross-team moves are covered by data tests, not browser QA. Temporary test skill and inserted composer draft were removed.
- Evidence: `.forge/agent-skills-qa/desktop-empty.png`, `desktop-editor.png`, `desktop-menu.png`, `mobile-menu.png`, `mobile-empty.png`, `use-in-chat.png`. No actionable UI-polish findings in inspected states. Light mode, physical touch devices and slow-motion inspection not verified. Existing TanStack devtools `path.endsWith` error appears in development logs; no skill flow failures observed.
- Validation: 28 focused tests across persistence, overview navigation, route hierarchy and app navigation; TypeScript, scoped ESLint, production build with Workflow handler verification and diff whitespace checks pass. React review checked stable module-level components, cleanup of storage listeners, explicit event handlers, accessible controls and initial editor snapshots for conflict detection.

## Team project updates guidance — 2026-10-12

- Implemented `/settings/teams/$teamSlug/ai/updates` from the supplied reference: fixed team link, title, exact description and a 640 × 180 px optional guidance field. Connected the Project updates overview row and navigation label.
- Guidance automatically persists on edit in versioned local storage per team. Empty guidance clears the value. Invalid stored data is preserved and editing disabled; failed writes retain the draft, offer Retry, and guard navigation/unload until saved or discarded. This is settings UI and browser-local guidance; automatic update generation is not connected.
- Authenticated browser QA at 1280 × 720 and 390 × 844 verified empty state, multiline entry, reload persistence, clear, and overview/back navigation. Mobile document width equals the 390 px viewport. Restored the test team's initial empty guidance. Evidence: `.forge/project-updates-qa/desktop.png` and `mobile.png`.
- Typecheck, scoped ESLint, 24 existing overview/navigation/routing tests, production build with Workflow handler verification and diff checks passed. No new tests added for this narrow page. Failure handling reviewed in source; storage failure/corruption, light theme and physical touch devices not exercised in browser. No actionable UI-polish findings in inspected states.

## Resolved thread summaries — 2026-10-12

- Added `/settings/teams/$teamSlug/ai/summaries` and the AI & Agents overview link/breadcrumb, matching both supplied references. Fixed team header, centered 640 px card, exact title/subtitle/description, muted Business availability state, and purple enabled-by-default Business switch. At narrow widths the upgrade link wraps below the description; the Business switch stays beside it.
- Eligibility reads existing workspace entitlements on the server: active/trialing Business and Enterprise show the switch, other plans show the Billing link. Team access is checked first; owners/admins and team members may edit, others see a disabled switch. The preference is currently local storage per team, not a server setting, and no thread-summary generation is implemented.
- Chromium component preview at 1440×900 and 390×844 verified free/Business/read-only states, keyboard toggling, reload persistence, billing/team links, no horizontal overflow, and fixed header during short-viewport scrolling. No page errors. Visually inspected `.forge/summaries-qa/business-desktop.png` and `free-mobile.png`; other state captures in the same ignored directory. Full authenticated shell and live paid-workspace behavior were not verified.
- Four targeted suites / 34 tests passed: plan/trial eligibility, team permission checks, inaccessible-team rejection, actual overview link navigation, route hierarchy, existing navigation cases. Typecheck, scoped ESLint, production build/Workflow handler validation, and diff whitespace checks passed.

## Personal notifications settings — 2026-10-12

- Added `/settings/notifications` and priority/Desktop/Mobile/Email/Slack detail routes. Connected the Personal sidebar and retained its selected state on detail pages. The overview follows the supplied Inbox, Push notifications, Changelog, Marketing, and Other updates sections with matching default states, compact controls, inset dividers, and the existing Forge shell/theme.
- Priority configuration is gated by Priority inbox. Delivery-channel rows open editable type selections, with enable/disable, Select all/Clear, preserved selections, and live summaries. Detail type names are inferred because only the overview was supplied. Copy uses Forge in place of Linear.
- Preferences are versioned and stored per signed-in user in this browser. Writes merge with current storage, mounted views synchronize, malformed saved data is preserved, and failed writes keep prior values. These are local preference controls; inbox prioritization, sidebar announcements, actual delivery, browser permissions, newsletters, and Slack integration are not connected to these values.
- Focused component/data/navigation verification: 26 tests pass, including priority gating, accessible checkbox labels, disable/re-enable retention, summary changes, update toggles, user isolation, synchronization, corrupt storage, and failed writes. Production build and protected Workflow verification passed. React review checked module-level components, event-handler writes and storage-listener cleanup.
- Rendered QA remains unverified: the authenticated preview initially showed only the settings shell; subsequent reload, tab reconnection and a fresh tab timed out in browser control. A named route layout replaced the directly assigned Outlet; fresh visual confirmation could not be obtained. No desktop/mobile screenshots or visual-pass claim are recorded for this page.
- Final scoped lint and diff whitespace checks pass. The final workspace typecheck is blocked by concurrent, unrelated `account-security-settings.test.tsx` errors at lines 100, 121, and 138 (`exact` is not a supported Testing Library role option); no notification-file type errors were reported.

## Personal Security & access — 2026-10-12

- Added `/settings/account/security`, distinct from workspace `/settings/security`, and connected the Personal sidebar entry and breadcrumb.
- Matched the reference’s 640px content column, 64px card rows, muted surfaces, green current-session indicator, and section spacing. Existing Forge shell and theme remain in use.
- Session list, individual revocation, all-other-session revocation, and logout use Better Auth. Tokens are never rendered. Confirmation precedes session mutations; failed mutations keep the original rows.
- The live desktop session required a recent sign-in (`SESSION_NOT_FRESH`). Verified the explanatory state and cancellable sign-in confirmation. The normal session-list and revocation states are covered by focused tests; no real user sessions were revoked during QA.
- Personal API keys use the existing authenticated API-key summary/policy service. New API key opens Forge’s existing scoped creation dialog. Verified that dialog in the desktop app without creating a credential.
- Passkeys, signing keys, and personal OAuth approval are not configured in the current auth schema. Availability dialogs and an honest empty application state avoid inventing security credentials or approved apps.
- Desktop UI and passkey availability dialog verified in Forge Desktop. Screenshot: `security-access-desktop.png` in this chat’s visualization directory. In-app browser reload/navigation timed out, so mobile browser verification was not completed.
- Focused tests: 13 passed across account security, session display, and existing API-key creation. Targeted ESLint, typecheck, production build, and diff check passed.


## Personal Code & reviews — 2026-10-12

Source visual truth: the two supplied Linear screenshots, preserved in `docs/audits/code-reviews/source-user-1.png` and `source-user-2.png`. Implementation: authenticated Forge desktop at `/settings/code-and-reviews`, `desktop-top-final.png` and `desktop-bottom-final.png`. Source attachments were resized to 1987×1248 in the conversation; desktop captures are 3600×2260 at a 1800×1130 CSS window / 2× density. Both were normalized to 1800×1130 for comparison. The source's supplied bottom scroll position and implementation's native scroll position differ slightly; matching card content is compared independently of that offset.

Full-view evidence: `comparison-full.png`. Focused content evidence: `comparison-top-final.png` and `comparison-bottom-final.png`. Comparison excludes deliberate existing Forge shell differences (desktop tabs, sidebar, breadcrumb and selected user theme).

**Findings and comparison history**
- [P2, resolved] Initial rows were taller than the reference, and content began about 8 CSS pixels too high. Reduced row and linked-row padding to 12px, retained 64px minimum rows, and raised the page's top padding to 24px. Final evidence preserves the 640px content width, 12px cards, inset separators, 48px section spacing and reference density.
- [P2, resolved] The existing Switch component's dark-theme thumb was nearly invisible against the track. Scoped thumb colors to this page and used the reference purple for editable switches and gray for gated controls. Final comparison shows both positions clearly.
- [P2, resolved] Initial card surfaces were too dark. Adjusted this page's muted surface opacity, with dimmer surfaces for gated sections.
- [P3, accepted] Hugeicons' GitHub outline differs from Linear's filled mark; it remains a real library icon. Geist and the user's existing Forge theme differ slightly from Linear's font and surrounding shell; existing product tokens are preserved.

**Required fidelity surfaces**
- Fonts/typography: existing Geist; 24px heading, 15px section headings, 13px labels and 12px helper text. Hierarchy, wrapping and compact control labels checked in the focused comparisons.
- Spacing/layout rhythm: centered 640px content, compact rows and reference card/section ordering; corrected vertical differences above.
- Colors/tokens: existing Forge page/shell tokens retained; card tones, inactive opacity, gray disabled tracks and purple active tracks checked.
- Image quality/assets: no raster imagery required; real Hugeicons supply GitHub, arrow and chevron icons. No approximated brand art added.
- Copy/content: reference setting labels and descriptions retained, with product name changed to Forge and accessible Option key text.

**Interactions and checks**
Authenticated Electron QA verified sidebar navigation, GitHub access explanation dialog, attachment format menu, branch-copy switch, coding-tool checkboxes, theme menu and light syntax preview, dialog dismissal, and preference persistence after reload. QA preference changes were restored to the initial defaults. Storage is validated and scoped to signed-in user ID; failed writes keep the previous visible value. React review checked module-level components, stable option lists, hydration-safe loading, guarded controls, accessible names and state, and immutable updates.

Three targeted suites / 25 tests passed (including user isolation, corrupted-storage recovery, save failure, disabled GitHub controls, saved toggles, coding tools and navigation). Scoped ESLint, full TypeScript, production build with Workflow handler verification, and diff whitespace checks passed.

**Boundaries and residual verification gaps**
Preferences persist on this device, consistent with the existing personal preferences pattern. The page does not connect GitHub, enable review notifications, upload signing keys, or execute downstream branch/status/tool behavior; its access dialog states that GitHub code access is unavailable. Theme and external-tool selections are saved configuration for future consumers. Mobile rendered verification and browser console inspection could not be completed: in-app CDP navigation/focus repeatedly timed out and Chrome automation was unavailable. Desktop rendered QA used the authenticated Electron app instead. No claim of mobile verification is made.

**Implementation checklist**
- Route, sidebar entry and breadcrumb connected.
- Reference sections and gated controls implemented.
- Working dialogs, selections and per-user local persistence verified.
- Source/implementation comparison complete; no actionable P0/P1/P2 desktop findings remain.

final result: passed

## Connected accounts — 2026-10-12

- Added protected `/settings/account/connections`, the Personal sidebar link, and its breadcrumb.
- Matched the reference’s 640px column, separate Slack/Google Calendar/Notion cards, two-row GitHub card, and MCP card with a 48px gap. Provider actions wrap below the text on narrow screens; the GitHub row uses the signed-in workspace’s actual name.
- Personal provider OAuth connections are not implemented in the current Forge backend. Connect actions explain availability without fabricating connection state, storing tokens, or granting access. The MCP row now links directly to the existing Agent personalization page and its workspace MCP settings section.
- Rendered layout, provider ordering, active sidebar state, workspace name, and Slack dialog verified in Forge Desktop. All four provider dialog flows, clean close behavior, and the MCP navigation target passed six focused tests.
- In-app browser reload/navigation repeatedly timed out. The desktop was being navigated during the remaining checks, so mobile visual verification and a final screenshot capture remain unverified.
- Six focused tests, targeted ESLint, production build (including protected Workflow verification), and diff check pass. The latest full-project typecheck reports two unrelated optional-icon errors in `templates/template-editor.tsx` and `templates/template-items.tsx`. Their ongoing edits were preserved.
- GitHub brand glyph source: Simple Icons, `https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/github.svg`.

## Agent personalization settings — 2026-10-12

- Route: `/settings/account/agents`; the existing Personal sidebar and desktop tab title now link to this authenticated page.
- Source: user-supplied Linear Agent personalization screenshot, saved as `docs/audits/agent-personalization/source-user-1.png` (1987 × 1248 input pixels). Desktop implementation: `desktop-final.png` (3600 × 2260 pixels, 1800 × 1130 CSS pixels). `comparison-final.png` normalizes both images to the same CSS dimensions and compares their 640px content columns together; `desktop-final-css.png` retains the surrounding Forge shell.
- Visual result: passed for the supplied desktop empty state. Guidance textarea height, section spacing, card geometry, text hierarchy, plus action, and Configure action match the reference within the existing Forge shell. Forge branding/fonts/shell are intentionally retained. The Skills description reflects the currently implemented manual “Use in chat” action instead of claiming automatic skill selection or slash-command invocation.
- Verified in component tests: guidance save on blur; storage failure retains the draft; cross-tab guidance conflicts retain both the draft and the saved record; personal skill creation, revision-aware editing, unsaved-change confirmation, deletion confirmation, and insertion into the existing chat draft; MCP disabled/enabled states, failure, retry, and Configure destination. Store tests cover account isolation, stale writes, corrupted-data preservation, and whitespace validation. Nine focused tests passed.
- Actual authenticated desktop page and disabled MCP policy were captured. Additional desktop interaction checks could not be completed: the shared native window changed during other work, native clicks subsequently did not activate the editor, and isolated IAB navigation timed out. Mobile rendering remains unverified. These are verification limits; no simulated screenshot or sign-in redirect is presented as page proof.
- Typecheck, scoped ESLint, production build including protected Workflow handler verification, and `git diff --check` passed.
- Implementation boundary: guidance and skills are validated, account-scoped local storage on this device, consistent with existing team skill storage. Skills can be explicitly inserted into the agent composer. Applying guidance automatically to runtime responses, selecting skills automatically, slash invocation, and cross-device/server sync are not implemented. MCP access is read from the real workspace security snapshot; Configure links to the real MCP section, with no access changes made during QA.

## Workspace issue labels — 2026-10-12

- Added `/settings/issue-labels`, the Issues sidebar entry, and breadcrumb by reusing the team labels implementation. The workspace view shows expandable colored groups, nested labels with tree guides, standalone labels, Rules/usage/date columns, creation, search, sorting, display options, group selection, inline editing, menus, and Undo. The supplied group names and visible Direction children seed only an unsaved directory; existing saved data, including an empty directory, takes precedence.
- Matched the supplied compact table layout using the existing Forge font, tokens, and shell. Root-level dots and group icon centers are aligned exactly (both x=70 in the 1280px preview); root label and group text share an origin, and children are indented 28px. Increased the chevron-to-icon separation by 8px while reserving room for the selection checkbox. Group name, icon, and noninteractive row space toggle expansion; Enter activates the name button. Selection, description editing, and action menus keep their separate behavior.
- Real-component browser preview verified collapse/expand, row-space clicks, keyboard activation, searching collapsed groups, group creation, nested label creation and persistence after reload, deletion with Undo, empty-group guidance, and standalone label alignment. Temporary QA rows were removed. Captures: `.forge/labels-qa/desktop.png` (1280x900, includes temporary standalone test label for alignment evidence) and `.forge/labels-qa/mobile.png` (390x844). The narrow table scrolls horizontally within its container; document width remained 390px.
- Three focused suites / 47 tests passed, including group/name/row toggling and event isolation, persisted group membership, selection, existing team behavior, parsing, and navigation. TypeScript, scoped ESLint, formatting checks, production build with Workflow handler verification, and whitespace checks passed.
- Persistence remains browser-local sample data, following the existing labels implementation. Group usage/date values in the supplied example are fixtures; live issue usage, Rules editing, and server synchronization are not implemented. Invalid saved data surfaces a load error and is not overwritten.
- Full authenticated-shell rendering could not be validated: localhost:3000 showed only the settings shell on multiple routes, including existing Preferences, alongside a TanStack devtools `path.endsWith is not a function` error. Visual/interaction evidence is from an isolated Vite preview rendering the actual component and styles, not a claim of authenticated end-to-end verification. No unrelated shell fix was included.

final result: component verification passed; authenticated-shell verification blocked as described above

### Label group chevron alignment correction — 2026-10-12

Centered the four-dot group glyph within its 12px box using explicit 3px grid tracks and centered content. The prior automatic tracks placed the visible dots 1.414px above the chevron center. Rendered measurements now match exactly for collapsed Design (y=215) and expanded Direction (y=259). Existing chevron spacing and row behavior are unchanged. Component preview evidence: `.forge/labels-qa/chevron-alignment.png`. Scoped ESLint and whitespace checks passed.

## SLAs settings — 2026-10-12

- Added the protected `/settings/sla` route, active Issues sidebar entry, generated route registration, and `SLAs` breadcrumb.
- Matched both supplied Linear states inside the existing Forge shell: centered 688px content, reference copy and Docs link, compact rounded settings surface, gated Automation rules section, and existing Forge button, switch, select, dialog, input, and icon components.
- Disabled is the clean default. Enabling SLAs reveals the Work week control and the five supplied initial priority rules: Urgent adds 24 hours, High adds 1 week, and Medium, Low, and No priority remove the SLA.
- Enablement, work week, and automation rules persist per workspace in validated local storage. Add, edit, and delete rule actions are wired; failed writes preserve the visible state and surface an error toast.
- Rendered source/implementation comparison covered disabled and enabled layouts plus the add-rule dialog in an isolated Forge preview. The shared authenticated desktop window was concurrently in use by other settings-page QA, so no claim of authenticated end-to-end or mobile rendering is made.
- Four focused component tests passed, covering disabled defaults, the enabled reference state, rule creation persistence, and workspace isolation. Targeted ESLint, full TypeScript, the production build with protected Workflow verification, and the repository whitespace check passed.

final result: passed

## Project labels — 2026-10-12

- Added `/settings/project-labels`, connected the Projects → Labels sidebar item, and named the page in desktop navigation. Reuses `TeamIssueLabelsSettings`, `TeamLabelRow`, `LabelGroupRow`, editor, color picker, filters, column controls, and bulk actions via an entity variant. The usage column and display option say Projects.
- Reference fixture contains collapsed Design, Development, Marketing, Operations, Product Management, and Sales groups with the supplied colors, counts, and dates. These are sample metadata rather than live project usage. Project labels use their own versioned local-storage key; issue-label data is unchanged.
- Three targeted suites / 48 tests passed. Added coverage for the six groups, project-specific column, creating a group and child label with the shared controls, persistence after remount, and isolation from workspace issue labels. Typecheck, scoped ESLint, production build with Workflow handler verification, and whitespace checks passed.
- Attempted current-route browser verification, but the in-app browser timed out during navigation again. No new rendered screenshot or authenticated visual verification is claimed. The shared issue-label components retain their previously inspected layout and interactions.

## Workspace Project templates — 2026-10-12

- Added `/settings/project-templates` and `/settings/templates/project/$templateId`, the Projects → Templates sidebar destination and active editor state, and list/editor breadcrumbs. The protected routes use the existing authenticated template directory. Workspace issue and project lists filter by kind, so templates cannot appear in the wrong list.
- Matched the supplied empty list and new-template screenshots within the Forge shell: centered 640px list, reference description and Docs link, rounded empty card and New template action; 750px editor with template name, icon, project name/summary, property chips, rich description, milestones, issues, visibility, Cancel, and Create/Save. The shared editor now returns workspace project templates to the correct list.
- Extended the existing database-backed workspace template service to accept projects while retaining workspace/creator derivation, management permissions, accessible-team/member validation, duplicate-name checks by kind, and revision-aware edits. The visibility picker defaults to Workspace and offers accessible teams; visibility is stored as template metadata following the existing template model. Deletion requires confirmation. Failed saves retain the draft. Project labels use the separate project-label directory rather than issue labels.
- Fixed a shared rich-editor initialization issue: changing editability now suppresses the content-update event, so opening a blank editor does not mark the template as changed. A regression test covers initialization and editability changes.
- Actual authenticated localhost browser rendering inspected at the default 1506x1034 desktop viewport and 390x844 mobile viewport. Captures in `/Users/matthieu/.codex/visualizations/2026/10/10/01a1261a-7373-7dd0-915d-bf2cdd1b43ca`: `project-template-editor.png`, `project-template-editor-final.png`, `project-templates-mobile.png`, `project-template-editor-mobile.png`. Mobile document width is exactly 390px. Verified list-to-editor navigation, Workspace/Testing visibility choices, draft name/title editing, milestone creation, and discard confirmation returning to the list. No live test templates were saved or deleted; save/edit/delete persistence was exercised through component and application-service tests with database mocks.
- Six focused suites / 33 tests passed, covering project create/edit/error/confirmation/permissions, milestones and unsaved drafts, project-label isolation, workspace service validation, issue-template regression, shared controls/items, and rich content. Scoped ESLint, formatting, and whitespace checks pass. Final full-project TypeScript and production build with protected Workflow verification pass. A temporary concurrent Project statuses import error resolved when its component arrived; that independent work was preserved. The final browser check showed Cancel on a fresh blank template changing the URL to the list without prompting to discard changes. That final client navigation remained pending; a subsequent reload timed out, so the settled list was not revalidated after the initialization correction. The list and editor had both rendered successfully earlier, and the correction has focused regression coverage.

## Initiatives settings and labels — 2026-10-12

- Added `/settings/initiatives` and `/settings/initiative-labels`, settings sidebar navigation, and desktop breadcrumb titles.
- Matched the supplied hierarchy, copy, cards, enabled/disabled states, schedule editor, and label empty-state illustration. Initiative labels reuse the shared labels table/editor/group/filter controls with separate storage.
- Settings and labels are local preferences, not server-driven initiative access control or a reminder scheduler. Slack broadcasting is unavailable; the page shows Connect and an explanatory dialog instead of claiming a live connection.
- Verified 53 targeted tests, typecheck, focused ESLint, production build, and `git diff --check`.
- CUA rendered both components in the isolated `.forge/initiatives-qa` preview; checked toggling, disabled controls, schedule editor, and labels empty state. Full app route showed only its shell and then timed out on reload, with a TanStack devtools error logged. Authenticated route rendering remains unverified. Labels screenshot: `.forge/initiatives-qa/labels.png`.

## Global typography weight refinement — 2026-10-12

- Softened the shared Tailwind font-weight tokens by 50 points: Medium 500 → 450, Semibold 600 → 550, Bold 700 → 650. Geist Variable supports the intermediate weights. Regular text stays at 400. Existing sizes, line heights, and semantic emphasis remain in place.
- Desktop tab labels, checklist rows, thinking text, and template rich-editor headings/summary now use the same tokens instead of literal 500/600 declarations. Native `b`/`strong` emphasis uses the shared Bold token. Brand glyphs and email templates are outside this page typography adjustment.
- Formatting, production build including protected Workflow verification, and `git diff --check` pass. Both the compiled production CSS and the running localhost development stylesheet contain 450/550/650.
- Rendered verification limitation: the existing in-app browser still reported the previous stylesheet before refresh; refresh and rebinding then timed out. The native app could be inspected but computed weights were unavailable there. No stale screenshot is presented as proof of the new weights; current rendered typography remains unverified.

## Custom emojis settings and shared picker — 2026-10-12

- Added the protected `/settings/emojis` route, Features sidebar destination, and breadcrumb. Preserved the shared shell and matched the supplied title, search/upload toolbar, sortable Name/Source/Added table, row hover removal action, and illustrated empty state.
- Upload previews the selected image and offers an editable shortcode derived from its filename. PNG, JPEG, GIF, and WebP inputs up to 2 MiB are normalized to a still PNG at most 128px per side. Invalid uploads, duplicate names, and failed saves retain a readable error. Removal uses a confirmation dialog; removed emojis disappear from the picker and existing references render a placeholder.
- Added database-backed workspace emoji storage and migration 0024; migration applied successfully. Authenticated server functions derive workspace and creator from the session, enforce workspace upload policy, reject guests/API-key actors, and restrict removal to the creator or workspace administrators. The workspace-keyed provider refreshes on focus and shares uploads/removals with all existing TeamIconPicker consumers. Stable references fit the existing icon contract; shared icon rendering displays custom images.
- Real-component CUA preview verified empty state, actual file decoding and resized preview, upload/name editing, populated row, shortcode search, custom picker selection/rendering, reload, no-match search, and confirmed removal returning to empty state. At 390x844, the document remained 390px wide while the table scrolled internally. Captures: `.forge/emojis-qa/empty.png`, `.forge/emojis-qa/picker.png`, and `.forge/emojis-qa/mobile.png`. The isolated preview uses a local fixture service; live authenticated database CRUD was not exercised through the browser.
- Six focused suites / 34 tests passed, covering upload/picker/removal behavior, duplicate and failed writes, workspace provider isolation, server authorization/scoping, input validation, standard picker/catalog regressions, and navigation. Targeted ESLint and whitespace checks pass. Production build including protected Workflow handler verification passes. Full TypeScript reports errors only in the concurrently developed `project-statuses-settings.test.tsx`; no emoji implementation or test errors remain.
- Full authenticated localhost route verification was blocked by the existing navigation timeout. Preview evidence is not a claim of authenticated end-to-end verification. No production deployment was performed.

## 2026-10-12 — Conditional team Cycles navigation
- Connected the main sidebar to the existing per-team Cycles preference. Cycles appears between Issues and Projects only when enabled; same-tab and cross-tab changes update the menu.
- Added a protected team Cycles route with an upcoming schedule preview using configured duration, cooldown, start weekday, and future count. This is a schedule preview, not persisted issue-cycle membership or the reference's full filter/detail UI.
- Validation: 25 focused tests passed (navigation, settings toggles, persistence, cross-tab changes, team isolation, corrupt preferences, schedule rendering); app typecheck, focused ESLint, production build, and diff check passed.
- Browser: real AppSidebar, TeamCyclesSettings, and TeamCycles rendered in an isolated Vite harness with mock auth/team data; verified enable adds link, disable removes it, enabled schedule renders. Screenshot: `.forge/cycles-qa/cycles.png`.
- Full app route verification remains limited: localhost:3000/teams/forge/cycles rendered the shell/breadcrumb but no route body, matching the pre-existing local behavior observed in prior settings work.

## 2026-10-12 — macOS title-bar alignment
- Increased the macOS top strip to 48px and centered the 26px tabs with 11px above and below. Sidebar toggle and history controls share the 24px vertical centerline.
- Positioned native traffic lights at x=24/y=17 to align the first button with the main sidebar icon/avatar inset and center 14px buttons on that same line.
- Updated sidebar/settings shell heights and panel/overlay top offsets together; browser styles and footer spacing remain unchanged.
- Validation: 21 existing window configuration/title-bar/tab tests passed; Electron main and preload builds passed; git diff --check passed.
- Visually inspected the updated renderer spacing in the native Electron development window. Native traffic-light relocation awaits a new window/relaunch of the rebuilt shell; the existing window was left open to preserve its active settings edit.

## Project statuses settings — 2026-10-12

- Route: `/settings/project-statuses`; Projects → Statuses navigates to the authenticated settings page. The tab/breadcrumb uses “Statuses”; the page heading uses “Project statuses”.
- Target: supplied Linear desktop screenshot, `docs/audits/project-statuses/source-user-1.png` (1987 × 1248 pixels). Implementation: authenticated Forge desktop `desktop-final.png` (3600 × 2260 pixels, 1800 × 1130 CSS pixels), normalized to `desktop-final-css.png`. `comparison-final.png` compares both 640px content columns at the same CSS density and idle state.
- Final result: passed for the supplied desktop layout and core settings interactions. Fixed stages, group headers, 60px status rows, 34px icon tiles, compact plus actions, rounded card, typography, and spacing follow the reference within the existing Forge shell. Hugeicons provide the workflow symbols; the outlined completed/canceled symbols are a remaining P3 library difference. Reference project counts are intentionally omitted because Forge’s Projects page is currently a placeholder, rather than inventing project usage.
- Rendered desktop QA: opened the add form; verified nine compact 18px color swatches in a 256px picker and its custom hex input; selected Red; attempted the existing “To do” name and observed the duplicate-name error; canceled the unsaved form; opened the Backlog menu and verified disabled Move up/Move down/Delete with the last-status explanation; opened Edit from that menu and canceled. Fixed the desktop input flex basis and anchored the color picker to the start of its trigger. The corrected form/picker is captured in `desktop-color-picker-final.png` and `color-picker-detail.png`; the menu and duplicate error are in `desktop-menu.png` and `desktop-validation.png`. No QA status was persisted in the live desktop workspace.
- Eleven focused tests passed: workspace isolation, validated unique names/colors, within-group ordering, deleting/restoring at the original position, stale-save protection, quota failure preserving drafts, corrupted-data preservation, component create/recolor/reorder/delete/restore, duplicate validation, cancellation, and disabled last-status deletion. Scoped ESLint, full app typecheck, production build/Workflow verification, and diff checks passed. Mobile rendering remains unverified because isolated IAB navigation did not respond; controls wrap at narrow widths, but source inspection is not represented as mobile proof.
- Runtime restart: at the user’s request, restarted the web and desktop apps. A concurrent shared-navigation change had briefly imported nonexistent `CycleIcon`; the source now uses `Clock05Icon`. Restarted Vite after this correction to clear the stale failed SSR module. Verified successful HTTP requests and the actual signed-in desktop Inbox, then navigated to Project statuses and exercised its controls. Web session: 61599, `http://localhost:3000`; desktop session: 74654. Both were left running.
- Implementation boundary: status settings are validated, versioned local storage scoped to the workspace on this device. Deleted statuses remain recoverable through Undo and the persistent Deleted statuses list. Server sync, live project usage counts, and applying statuses to project records are not implemented. View projects links navigate to the existing unfiltered Projects route.

## 2026-10-12 — Native tab sizing follow-up
- Rebuilt and fully restarted the Electron development app to load the native traffic-light placement; the user confirmed the result.
- Increased macOS tabs from 26px to 30px, centered with 9px above and below in the 48px title bar.
- Increased tab content horizontal padding from 7px to 11px and close-button trailing space from 3px to 7px.
- Verified the updated tabs in the running native app; diff check passed. Screenshot: `/tmp/forge-taller-tabs.png`.

## 2026-10-12 — Upcoming and numbered cycle pages
- Added nested Upcoming navigation beneath enabled teams' Cycles links. Added numbered cycle routes and dynamic tab/breadcrumb titles; Cycle 1 and Upcoming share the same cycle issues, while later cycles remain separate.
- Replaced the schedule preview header with the supplied timeline layout: full clickable rows, date markers, cooldown intervals, Upcoming/Planned badges, and live scope counts. Capacity remains unavailable for populated cycles because no estimation model exists yet.
- Detail pages reproduce the supplied empty-state text/illustration and support local issue creation/editing, Board/List views, status filtering, and a details panel. Local records are validated and scoped by team and scheduled start date; server issue synchronization and persistent historical cycle identities are not implemented. The existing rolling schedule remains in use.
- Validation: 30 focused tests passed across navigation, settings, and issue flows (including cycle separation, persistence, corrupted storage and failed saves). Typecheck, scoped ESLint, production build/Workflow verification and diff checks passed.
- Native QA: restarted development Vite and Electron after a stale renderer refresh, inspected the final timeline and clicked Cycle 2 to verify the numbered route, tab, breadcrumb and empty state. No sample issues were written into the user's team. Populated-board behavior was verified in component tests; mobile rendering was not visually verified.
- Screenshot: `.forge/upcoming-cycle-qa/native-timeline.png`.

## Team Triage — 2026-10-12
- Added a team-scoped Triage route and live sidebar visibility tied to the existing team enable setting; disabled direct routes point back to settings.
- Matched the supplied split-pane layout, compact queue header, empty-state illustration, display popover, and responsibility dialog while preserving the Forge shell.
- Implemented local issue creation/editing, text/priority/due-date filters, ordering, snooze visibility, and property toggles. Responsibility preferences are shared with Settings; automatic notification/assignment execution remains unavailable and is disclosed in the dialog.
- Local storage validates issues and settings, preserves corrupt values, keeps teams isolated, and retains unsaved drafts after write failures.
- Native QA: enabled Testing temporarily, confirmed sidebar navigation and the page, opened Display options and responsibility settings, then restored the original disabled setting. Screenshot: `.forge/triage-qa/native-triage.png`. No sample issues were written to the real team.
- Validation: 35 focused tests passed, TypeScript passed, scoped ESLint and diff whitespace checks passed. Narrow layouts stack queue/details; mobile rendering was not separately inspected.

## Triage create-issue composer — 2026-10-12
- Matched the supplied Linear composition with a 750px dialog at 18vh, team/template controls, draft/expand/close actions, borderless title and description, inline property pills, attachment action, Create more switch, and purple creation button. The composer uses a dim backdrop without blur; other dialogs retain their existing backdrop.
- Drafts persist per team and restore on reopening. Create more clears the created content while retaining chosen properties. Existing team templates and members populate the template/assignee controls. Project and label values, due dates, and small attachments persist with local issues; attachment downloads are available in details.
- Boundaries: issue and draft data remain on this device. Project/label entries are local metadata, status stays Triage, and cycle assignment is explicitly unavailable. No server issue synchronization was added.
- Validation: 44 focused tests passed across Triage, settings, cycle creation, and navigation, including saved-draft restoration, corrupt-draft preservation, consecutive creation, template properties, and attachment persistence. Typecheck, scoped ESLint, production build/Workflow verification, and diff whitespace checks passed.
- Native QA: opened Triage and the new composer in the running Electron app, verified focus, typing, and Create issue enabling; inspected the full rendered dialog. Screenshot: `apps/forge/.forge/triage-qa/native-create-issue.png`. Preview text was not submitted. The native window subsequently closed during cleanup; no sample issue was created. Header controls wrap on narrow screens, but mobile rendering was not separately inspected.

## Triage filters — 2026-10-12
- Replaced the basic filter popover with the reference's searchable category menu, grouped separators, compact rows, nested choices, and F shortcut. Applied conditions appear below the queue header with individual removal and Clear filters.
- Added an advanced dialog with all/any matching and editable conditions. Assignee, priority, labels, project, dates, content, links, and template conditions filter the existing local issue records. Categories whose data is unavailable explain that limitation; they do not apply pretend conditions.
- Native QA: inspected the complete menu in Electron, confirmed search autofocus, opened the Priority submenu with the keyboard, applied Urgent and observed its chip, cleared it, and reopened with F. No sample issue was created. Screenshot: `apps/forge/.forge/triage-qa/native-triage-filters.png`. Mobile rendering was not separately inspected.
- Validation: 52 focused tests passed across filters, Triage, settings, navigation, and cycles. Typecheck, scoped ESLint, production build/Workflow verification, and diff whitespace checks passed.

## Teams directory — 2026-10-12
- Matched the supplied compact Teams header, New team link, Find teams search, inline identifiers, Description/Membership/Members/Cycle/Active projects columns, joined badge, avatar previews, and hover row actions.
- Added the searchable reference filter menu and F shortcut, real team-name/member/owner/privacy/created-date conditions, all/any advanced conditions, removable chips, and combined text search. Complete member identities are included in the already workspace-scoped directory response so filtering does not stop at the five-avatar preview.
- Added the ordering/direction popover and all eight display-property toggles. Team owners correspond to the existing team lead role. Joining a public team now persists through a session-authenticated server function with workspace, scope, private-team, and idempotency checks.
- Row menus expose membership actions, Favorite, Team settings, Copy URL, Open archive, Subscribe submenu, and Slack notifications. Favorites remain page-session state, consistent with existing behavior. Parent-team hierarchy and notification integrations are explicitly unavailable. Active project counts use an unavailable indicator rather than an invented zero; the existing Projects route and archive route remain their destinations.
- Native QA: inspected Teams and the display popover, opened row actions, opened Members with the keyboard, applied Current user and confirmed its chip, cleared it, reopened with F, and opened/canceled the advanced dialog. No team membership or sample data was changed. Subsequent UI checks were interrupted by user window changes, so stopped interacting. Screenshots: `apps/forge/.forge/teams-qa/native-row-actions.png`. Narrow columns use existing responsive breakpoints; mobile rendering was not separately inspected.
- Validation: 30 focused tests passed across the Teams page/filter evaluator and team application module. Typecheck, scoped ESLint, production build/Workflow handler verification, and diff whitespace checks passed.

## Team Home — 2026-10-12
- Added Home before the existing team navigation items, selected across Overview, Documents, Loops, and Members. Teams directory names now open Overview, and member previews open the team Members tab.
- Matched the supplied shared header, pill tabs, two-column Overview, document empty state, six loop templates, and member table while preserving the Forge shell. Overview includes the existing icon picker, editable name/description, member shortcuts, resource menus, and collapsible/reorderable sections.
- Team details and membership use the existing authenticated server flows and permissions. Documents, links, sections, favorites, and loop drafts persist per team on this device. Loop execution, prompt generation, and trigger integrations remain unavailable and are disclosed in the editor. Deleting a section keeps its resources.
- Validation: 45 tests passed across Home interactions/storage, membership settings, navigation, and Teams directory. Typecheck, scoped ESLint, production build/Workflow handler verification, and diff whitespace checks passed. Coverage includes reload persistence, team isolation, unsafe URLs, corrupt storage, failed writes, and template editing.
- Native QA: inspected all four tabs in Electron, opened document and loop editors, checked Weekly wrap prefill, Escape dismissal, and the existing Add a member dialog. No real team data or membership was changed. Left the app on Overview. Screenshots: `apps/forge/.forge/team-home-qa/{overview,documents,loops,members}.png`. Narrow viewport rendering and native drag-reordering were not separately exercised.

## Team Home interactions — 2026-10-12
- Refined Overview shortcuts and the grouped member preview into compact hover/focus pills with reserved-space chevrons, delayed dark tooltips, pressed feedback, and explicit focus rings. Add members and section/resource actions reveal on hover or focus, and remain available on touch. Section Add resources stays quiet until hover/open; icon controls retain their open-menu background.
- Inline name and description fields now show edit affordances. Escape restores the original value without triggering a blur save. Enter and blur retain the existing save behavior. Internal shortcuts now use client-side navigation.
- Validation: six Home interaction tests, scoped lint, typecheck, and diff whitespace checks passed. Native Electron QA confirmed resource menu opening and Escape focus restoration, member focus/reveal, and the Connect channel tooltip/chevron. Screenshot: `apps/forge/.forge/team-home-qa/shortcut-focus.png`. No team data was changed; pointer-hover and touch states were implemented in CSS but not separately exercised with automation.

## Team Issues — 2026-10-23

### Comparison target and evidence

- Source authority: the user's 11 empty-state/composer/filter/display screenshots and six populated-state screenshots, with their accessibility trees. A fresh read-only capture of the same Linear Test team is saved at `docs/qa/team-issues/linear-reference.png`.
- Implementation: `http://localhost:3000/teams/testing/issues?view=all`. Captures in `docs/qa/team-issues/`: `empty.png`, `populated.png`, `priority.png`, `display.png`, and `composer.png`.
- Source: 3600 × 2260 physical pixels, approximately 1800 × 1130 logical pixels at 2× density. Implementation: 885 × 1034 for the composer/display pass and 1506 × 1034 for the final empty/list/picker pass, captured at 1×. The browser panel widened during the session. Comparisons account for the different viewport widths and Linear's native top bar; they are not a pixel-diff or a claim of identical full-frame geometry.
- Inspected the source and rendered implementation together, focusing on the issue header/tabs, grouped row, selected toolbar, composer, property picker, and display menu. Live source has the supplied Todo issue; implementation uses a clearly named local QA issue in Backlog, assigned with High priority, plus a saved draft and Review queue view. The supplied selected-row screenshot is the authority for the selection state.

### Findings and iteration

1. [P2, fixed] The first empty-state illustration used flat colored status glyphs. Replaced it with a generated raster sprite depicting the reference's four stacked status tokens, with active/backlog/all variants. The second generated version removed noisy transparency and broad filled rims. Final evidence: `empty.png`.
2. [P2, fixed] Shared select sizes overrode compact display heights and truncated “Show matching.” Scoped the selectors to 24 px height and 128 px width. Final evidence: `display.png`; grouping and layout controls remain accessible Base UI selects.
3. [P2, fixed] Switch thumbs inherited a dark checked color; used a white thumb and compact 24 × 16 control. The composer switch precedes its label, as in the source. Final evidence: `display.png` and composer runtime check.
4. [P2, fixed] Assigned issues initially retained a generic person icon, and priority used a flag. Added member initials and library signal-strength/urgent icons. Final evidence: `populated.png`, `priority.png`.
5. [P2, fixed] The external documentation link triggered Base UI's native-button warning. Declared the non-native link semantics explicitly. No new issue-page runtime warnings after correction; an existing TanStack devtools `path.endsWith` error still occurs on full reload and was already present on Inbox before this work.
6. [P3, accepted] Forge retains its own sidebar, workspace/team icon, Geist typography, and shared menu styling. The generated illustration is a faithful stylistic adaptation, not Linear's original art; the backlog sprite uses solid rather than dotted top rings. These differences do not change the observed workflows.

### Required fidelity surfaces

- Typography: compact 12–13 px controls, 13 px rows, medium headings, and the prominent composer title follow the hierarchy. Existing Forge Geist is retained. Text wrapping was checked at both observed desktop widths.
- Spacing/layout: 44 px header, pill navigation, compact grouped rows, 750 px composer maximum width, 300 px display panel, lower centered selection bar, and the centered empty-state content match the reference structure. Forge's native/browser shell geometry remains unchanged.
- Colors/tokens: issue canvas uses #111111 in dark mode, purple creation/selection accents, muted metadata, subtle group surfaces, and readable focus/selection states. Existing shared surfaces and semantic workflow status colors are retained.
- Image quality: generated PNG status-token artwork is clean at its displayed 96 × 82 region; Hugeicons and the existing status component supply interface icons. Team icons remain the actual workspace configuration.
- Copy/content: source empty-state copy, tabs, filter category names, display properties, composer actions, inline menus, creation toast, and selection actions are represented. “Ask Forge” replaces “Ask Linear.” Local-only behavior is disclosed in the notification/default/AI helper UI.

### Behavior verified

- Browser: create an issue with description and priority; show creation confirmation; change status inline and observe regrouping; assign an actual member; select the issue and move it to Backlog; verify scope tabs; switch List/Board and reload; apply a nonmatching priority filter and clear it; save a custom view; open details; save an unfinished draft through the close confirmation; reopen it, add an http(s) reference, and resave; use a numbered priority shortcut and verify the selected result.
- Automated: issue numbering/children/draft consumption, scope transitions, filter all/any semantics, ordering, view serialization, recurrence and month-end handling, corrupt storage/write-failure preservation, and team isolation; existing app navigation regression suite.
- Validation: focused tests, TypeScript, scoped ESLint, production build including protected Workflow handler verification, and whitespace diff check.
- Implemented but not separately exercised in the browser: file uploads, board drag/drop, recurring completion, deep sub-issue trees, every advanced filter combination, create-more, and cross-tab notification preferences. Recurrence/storage logic is covered by unit tests. Mobile breakpoints were not separately rendered.

### Data and integration boundaries

Issues, drafts, preferences, and custom views persist per team in versioned browser storage, matching the existing local triage/cycle feature pattern. Team membership and assignment choices use the existing authenticated directory. There is no new server-backed issue sync, external notification delivery, or scheduled recurrence service. A recurring successor is created when its predecessor completes. AI filter is an explicitly labeled local query helper; Ask Forge opens the existing agent composer without submitting a message. Invite and assign opens the existing member settings. Attachments are bounded to five files / 2 MB in local storage.

### Implementation checklist

- [x] Empty and populated scopes; creation/drafts/editing; inline status/priority/assignee controls.
- [x] Filters and advanced conditions; persistent display options; custom views; details panel.
- [x] Selection/bulk updates; board grouping/drag handling; links/due dates/recurrence/sub-issues/attachments.
- [x] Validation failures preserve data; keyboard and semantic control checks; rendered browser proof.
- [x] Preserve the existing Forge shell and client-side navigation.

final result: passed for the reference-driven local Issues implementation, with the explicit integration and coverage boundaries above.
