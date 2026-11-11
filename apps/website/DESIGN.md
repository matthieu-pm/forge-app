# Forge hero

## Brief
A bounded marketing hero for Forge, the workspace for people and agents. Reference: the user's local video, pale graph paper and dimensional animated ASCII sharks around a calm central message. Substitute humans. Existing app remains a separate application at app.forgenow.tech. English; no invented customers, metrics, or availability claims.

## Concepts
| Territory | Idea | Signature | Emotion | Screenshot | Originality / fit / feasibility / portability |
| --- | --- | --- | --- | --- | --- |
| Material | Human-readable: human forms rendered in the characters agents work with | Shaded ASCII people walk around real HTML type | Quiet possibility | Human figures orbiting the message | 4 / 5 / 5 / 2 |
| Name | A digital foundry assembles people from sparks | Characters converge into a person | Energy | An emerging silhouette | 4 / 4 / 3 / 3 |
| Process | A shared workbench connects people to agents | Moving lines connect human silhouettes | Collaboration | A map of a team | 3 / 5 / 4 / 3 |

Choose Human-readable: closest to the supplied reference and directly expresses Forge's people/agent relationship.

Idea: Human ambition and machine execution share one space.
Metaphor: Human-readable source code.
Signature: Procedural people who walk across the page, resolved into shaded ASCII tiles on graph paper.
Emotion: Calm, curious, quietly alive.
Motion verb: Walk through.
Screenshot: A centered two-line headline with large ASCII people walking past and behind it.

## System
Stack: Vite with semantic HTML, CSS, a canvas renderer, and one GSAP ticker. A static marketing surface needs no application runtime or database.
Palette: ground #fafbf9, ink #202421, muted #646b65, line #e9ece7, accent #52634d, curtain #fafbf9.
Typography: self-hosted Host Grotesk variable (Google Fonts, OFL), 300 display / 400 body / 500 controls. Canvas uses the local monospace stack for ASCII.
Grid: 12 columns, 40px desktop / 22px mobile gutters. The graph grid matches the ASCII cell (about 12px desktop, 7px phone), so every tile sits in a square. Headline centered behind a frosted veil; people cross the whole floor and blur as they pass behind the copy.
Shape: 6px button corners; pill for a small introductory link only.
People: each body is built in code from spheres (head, hair, torso, limbs, optional coat, skirt, backpack, or bag) with randomised height, build, clothing, and tone. The walk plants each foot for the whole stance phase and moves the body one stride per cycle, so feet do not slide. People enter and leave at the sides; depth is bounded so a head is never cropped.
Rendering: spheres are drawn into a depth buffer at 3x3 samples per cell, lit from the upper left, then resolved per cell into a tinted tile and a glyph chosen by darkness. Partly covered cells become loose marks, a dotted shadow falls on the floor, and clouds of dashes drift across the empty paper.
Motion: single time driver from GSAP; slow-motion walk (about 2.5 to 3.2 seconds per stride); 24fps ASCII render budget; pause when hidden/out of view; static reduced-motion scene; no smooth scroll or loader.
Composition:
```
Forge                    context                    Sign in
     HUMAN                                   HUMAN
                 Built for humans.
                 Ready for agents.
                     description
                  primary / secondary
           HUMAN                                 HUMAN
context                                     motion control
```
Phone: three walkers at a smaller cell size, shorter line length, enlarged touch controls.
Genericness check: removed feature-card grids, glowing gradients, fabricated stats and decorative terminal chrome. The reference-specific ASCII scene carries the entire hero.
Scope: hero only; native accessible dialog supplies a brief product explanation without inventing extra pages. No public domain deployment as part of this implementation; review the concrete hero first.
