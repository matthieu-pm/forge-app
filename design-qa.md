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
