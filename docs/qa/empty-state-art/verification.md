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

## Issue binder page turn — 2026-10-28

- The issue sheet now turns a full 180° from right to left across three
  semicircular metal rings, pauses, and returns. The idle loop lasts 7.2 seconds;
  each turn lasts 1.8 seconds. Hover or keyboard focus starts an early turn.
- The 47 physical parts retain the cover boards, pocket, indexed dividers,
  corner guards and punched sheet. The ring arcs are divided into convex sectors
  at the page plane; 91 generated poses preserve true occlusion through the turn.
  The same pose sequence is used by the motion controller and geometry audit.
- All 91 displayed poses pass clearance, support, coverage and depth-order audits
  with zero failures. The audit checks the actual background/animation layer split,
  including stationary pieces that must occlude the moving sheet.
- The isolated 390px figure preview has no horizontal overflow. Reduced-motion
  preview remains on its right-hand resting pose.
- Dark and light 4× captures at 0°, 44°, 90°, 134° and 180° were inspected.
  The Anatomy line checker reports zero floating ends on all ten captures.
- The real Active issues page shows an automatic turn without hovering. Animation
  pauses offscreen and under reduced motion; disposal cancels its frame request.
  Geometry changes also remount the controller so a development update cannot
  leave it pointing at a replaced SVG group.
- Five motion regressions and eight issue-view tests pass, along with focused
  lint, application typecheck and diff whitespace validation.
- Other figures retain their existing geometry and motion. Generated milestone
  galleries only pick up the updated shared controller and stylesheet.

## Animation rerender regression — 2026-10-28

- Reproduced the reported freeze in the user’s live tab: the phase advanced but
  the visible sheet’s path remained at the right-hand resting pose.
- A real React component test reproduced the cause: rerendering EmptyStateArt
  detached the animated group, leaving its controller writing into an old node.
  The inline dangerouslySetInnerHTML object was recreated on each render.
- Memoizing that markup object preserves the animated subtree when its parent
  rerenders. The test verifies the group stays attached and its visible paper
  continues through distinct turning, left-hand and right-hand poses.
- The original live tab now shows changing sheet paths through the full turn.
