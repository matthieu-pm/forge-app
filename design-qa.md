# Design QA — Create a new team

## Result

blocked

## Evidence

- Reference: `docs/audits/create-team-linear-reference.jpeg` (1223 × 768)
- Implementation: `docs/audits/create-team-forge-implementation.jpeg` (1224 × 768)
- Full side-by-side comparison: `docs/audits/create-team-comparison.jpeg`
- Focused form comparison: `docs/audits/create-team-form-comparison.jpeg`
- Interaction states:
  - `docs/audits/create-team-icon-picker.jpeg`
  - `docs/audits/create-team-timezone-picker.jpeg`
  - `docs/audits/create-team-copy-picker.jpeg`

Both captures use the same desktop window size and the same default form state. The implementation intentionally uses Forge's light theme and existing component tokens while matching the Linear reference's hierarchy, geometry, density, and interaction model.

## Required fidelity surfaces

- Settings sidebar with active Create a team entry
- Back affordance and centered page header
- Three-row team identity card
- Team access, timezone, and copy-settings sections
- Bottom-aligned Create team action
- Icon/emoji, timezone, and copy-team popovers

## Comparison findings

- Page title, form width, card heights, section spacing, and CTA placement align with the reference at the target viewport.
- The first pass exposed a P0 routing issue where the page rendered inside the settings placeholder. The route was detached from the settings layout and rechecked.
- The next pass exposed overly compressed vertical rhythm. Row height, section spacing, top offset, and heading scale were adjusted and rechecked.
- Final side-by-side review found no remaining P0, P1, or P2 visual issues.
- Theme color differences are intentional: the implementation inherits Forge's current light desktop appearance rather than replacing the app-wide theme.
- A later browser capture exposed a P2 shell overflow: the route-height wrapper plus the web inset margin allowed the whole page to move and hide the Back control.
- The create-team route now uses a viewport-height, overflow-clipped shell; the inset and form canvas are also non-scrollable. Popover lists retain their own intentional scrolling.
- Post-fix visual recapture is pending because the user asked that Computer Use not be used. This blocks the Product Design visual gate, but not the automated engineering checks.

## Interaction QA

- Icon picker opens and exposes icon/color choices.
- Emoji tab opens and exposes searchable emoji choices.
- Timezone picker opens with search and selectable timezone options.
- Copy-settings picker opens with search, Don't copy, and existing team choices.
- Name and identifier inputs expose accessible labels; identifier normalization and required-field validation are implemented.
- Create team validates the form, reports success, and navigates back to the teams area.

## Engineering checks

- Typecheck: passed
- Production build: passed
- Targeted navigation/title-bar tests: passed
- Targeted lint: passed
- Diff whitespace check: passed
- Authenticated Electron/Chromium rendering: passed
- The isolated in-app browser preview redirects to sign-in because it does not share the Electron session; the authenticated desktop target was used for final visual and interaction evidence.

## Current blocker

The P2 page-scroll correction is implemented, but a post-fix screenshot of the authenticated Aside session is unavailable without Computer Use. Refreshing the page and confirming that a scroll gesture no longer moves the Back control will unblock the final visual gate.
