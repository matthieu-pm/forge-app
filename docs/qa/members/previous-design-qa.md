# Issues detail panel QA

final result: blocked

## Findings

- Source capture is blocked. The four user-supplied Linear screenshots are the visual target, including `Linear Appshot 2026-10-26T23-40-23.668Z.png` (Projects). The native Linear accessibility tree exposed the open panel and its four tabs, but screenshot capture repeatedly returned the closed-panel state. Those invalid source captures and the resulting invalid comparison were discarded. A synchronized, saved side-by-side visual comparison cannot be signed off.
- The implementation is complete and its primary desktop interactions were verified in the in-app browser. This status applies to visual sign-off, not a failed functional test.

## Evidence and state

- Implementation URL: http://localhost:3000/teams/testing/issues?view=active
- Implementation captures: `docs/qa/issue-details-panel/forge-projects.png`, `forge-labels.png`, and `forge-priority.png` in that directory.
- Browser viewport and screenshot: 1280 × 720 CSS/pixel dimensions at 1× density.
- Supplied source dimensions: 3600 × 2260 pixels, displayed at 1987 × 1248 in the conversation. A native source capture would normalize to 1800 × 1130 CSS pixels at 2× density, but the capture was the wrong state.
- Theme: dark. Active team issues with summary panel open. Forge's local Testing dataset differs from the supplied SKEMA dataset; no production issue data was changed for this verification.
- Full-view and focused-region comparison: blocked by the source capture mismatch. No pixel-accurate fidelity claim is made.

## Required fidelity surfaces

- Typography: reused Forge's existing font and 12px tab/count, 13px row sizing. Rendered labels fit the desktop tab bar; long row labels truncate.
- Spacing/layout: rounded, inset panel; four pill tabs; aligned icon/name/count rows; 428px maximum desktop width and 320px minimum width. Browser rendering checked at 1280 × 720. Mobile overlay close control is implemented and component-tested; mobile browser rendering was not captured.
- Colors/tokens: existing semantic tokens with dark panel #1a1a1a and selected tab #303030; existing team label colors and purple project marks.
- Assets: reused existing Hugeicons, assignee avatar, and priority components. No custom raster assets were needed for the panel.
- Copy/content: Assignees, Labels, Priority, Projects, actual property names and counts; missing values and an empty view have explicit copy. Final visual comparison remains blocked as above.

## Functional verification

- Panel opens using the existing toolbar toggle.
- All four tabs switch and show counts derived from the current visible issue set.
- Project row click filters the list and updates the count; clearing filters restores the list and summaries.
- Component tests cover counts across all four dimensions, repeated-label deduplication, missing-value filters, multi-label matching, changing input/empty state, keyboard tab navigation and close callback.
- 24 focused tests passed across the panel, issue list, and team issue logic.
- ESLint passed for changed components/tests. Workspace TypeScript check passed on the final run.
- Browser console inspected: earlier sidebar hydration warning and TanStack devtools `path.endsWith` error appeared before the panel was opened; neither stack references the new component. Panel interactions completed without additional errors in the inspected logs.
- React best-practices checklist: derived summaries computed during render, local tab state, stable row keys, typed props, accessible tab roles/relationships and keyboard handling; no additional fetches or global listeners.

## Comparison history

1. Supplied reference reviewed; initial Forge render checked for inset panel, pill tabs and aligned count rows.
2. Added minimum desktop panel width to keep tab labels usable at narrower desktop sizes.
3. Native source capture returned the wrong state despite the open-panel accessibility tree. Invalid comparison was discarded; visual sign-off remains blocked.

## Implementation checklist

- [x] Replace placeholder panel with four live summaries.
- [x] Connect rows to existing filters.
- [x] Verify primary interactions and focused tests.
- [x] Run lint and TypeScript checks.
- [ ] Obtain a synchronized source capture and compare full/focused views at a matched viewport.

## Follow-up polish

- Recheck the narrow viewport overlay and light theme in the browser when completing visual sign-off.
