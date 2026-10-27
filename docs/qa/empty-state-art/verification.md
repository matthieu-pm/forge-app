# Empty-state artwork verification — 2026-10-27

The shared SVG component replaces the existing illustrations in Inbox, Signals,
Reviews, team Issues, My issues, issue Views, Initiatives, Triage, Upcoming cycles,
Calls, Projects, custom Views, team Documents, custom Emojis and initiative Labels.
Projects inside an initiative reuse the same filing-cabinet illustration.

Thirteen figure families share one camera, app theme colors and sizing. SVG
geometry is generated ahead of time with the Anatomy kit. No skill files or
geometry engine are imported by the running app. Motion uses a short CSS
transition on supported mechanisms, enabled on hover or action focus, and is
suppressed by reduced motion. Inbox, Reviews and Signals now also have gentle visible-only idle motion. The mailbox flag pivots in its side plane, the microscope adjusts its mechanical stage and focus dial with bounded lamp illumination, and the satellite drifts as a rigid body. The shared controller is used by React and the QA gallery, pauses offscreen and follows reduced motion.

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

## Motion correction — 2026-10-27

- Replaced the static mailbox flag with a 65° pivot. Checked geometry at 17 angular
  poses; no unsupported solids, intersections, coverage or depth-order failures.
- Increased microscope focus-carriage travel to 7 world units; its condenser,
  slide and clips move with their mounts. Focus dial and lamp make the change
  legible at the normal icon size. Geometry checks pass across 61 positions.
- Removed the satellite's unrelated scan tab. Every spacecraft part moves
  together, with gentle drift and a 3° attitude change.
- Motion is automatic when visible and responds to hover/action focus. The
  controller writes CSS variables without React frame rerenders.
- Verified ongoing phase changes in the app; QA gallery confirms offscreen pause
  and reduced-motion stillness. Both-theme moving-pose screenshots and line checks
  pass. Focused TypeScript/lint checks and 17 Inbox/Reviews/Signals tests pass.

## Calls smartphone — 2026-10-27

- Replaced the conference speakerphone with a face-up smartphone: 58 recorded
  solids, including the chassis, glass, earpiece mesh, camera, side keys, USB-C
  port, lower speaker apertures, and a decorative call screen.
- The phone stays assembled. Its screen waveform follows the shared eased,
  visible-only animation controller, including action focus and reduced motion.
- The geometry audit passes with zero support, intersection, coverage, or depth
  failures. Thin screen inlays use a 0.01-unit depth tolerance so the mesh and
  display marks paint over their actual host rather than disappearing beneath it.
- The Anatomy line-end checker reports zero floating ends in dark and light.
  The same checker ran inside local QA pages controlled through the browser tool.
- Normal-size and 4× dark/light views were inspected. The 390px preview has no
  horizontal overflow. Focus raises waveform opacity to 0.95; reduced motion
  keeps it at 0.45. The actual Calls page shows the smartphone and animates it.
- A comparison against the prior generated collection confirms that only the
  `calls` figure changed; all other figure bodies are byte-identical.
- Application typecheck, focused lint, and 27 Calls/project/issue-view tests pass.
