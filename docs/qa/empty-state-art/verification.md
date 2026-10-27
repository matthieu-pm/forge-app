# Empty-state artwork verification — 2026-10-27

The shared SVG component replaces the existing illustrations in Inbox, Signals,
Reviews, team Issues, My issues, issue Views, Initiatives, Triage, Upcoming cycles,
Calls, Projects, custom Views, team Documents, custom Emojis and initiative Labels.
Projects inside an initiative reuse the same filing-cabinet illustration.

Thirteen figure families share one camera, app theme colors and sizing. SVG
geometry is generated ahead of time with the Anatomy kit. No skill files or
geometry engine are imported by the running app. Motion uses a short CSS
transition on supported mechanisms, enabled on hover or action focus, and is
suppressed by reduced motion. The reference mailbox is a still figure.

Validation:

- Application TypeScript check passed.
- Focused ESLint checks passed with no errors.
- 103 existing page tests passed across 11 suites (74 primary page tests and
  29 Emojis/Labels tests). No tests were added for static path markup.
- Anatomy line checks: zero floating ends in dark and light, including mechanism
  hover poses. Printed label rules are explicitly exempted as text.
- The three reference-driven rounded figures record every visible solid. Their
  geometry audits pass at rest and across 61 mechanism positions, checking
  clearances, support, coverage and depth order. No audit exceptions are used.
- 4× close-ups inspected in both themes. The filing cabinet's far corner stays
  behind its folders and drawer front. The mailbox roof uses continuous shading;
  its front hinges are attached outside the door face.
- Desktop and 390px gallery checked; no horizontal overflow or console errors.
- Browser verification confirmed the new mailbox, satellite and microscope in
  their actual Inbox, Signals and Reviews pages. Existing text/actions remain.

Regenerate the ignored two-theme QA galleries with:

```sh
node apps/forge/scripts/illustrations/build-empty-state-art.mjs --audit
```

The prismatic figures use kit slabs/frames; the reference-driven microscope,
satellite and mailbox additionally use recorded turned, saddle and arched solids.
