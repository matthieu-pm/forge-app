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
Signature: Procedural, articulated 3D human surfaces resolved into ASCII cells on graph paper.
Emotion: Calm, curious, quietly alive.
Motion verb: Walk and drift.
Screenshot: A centered two-line headline framed by oversized dimensional ASCII people.

## System
Stack: Vite with semantic HTML, CSS, a canvas renderer, and one GSAP ticker. A static marketing surface needs no application runtime or database.
Palette: ground #fafbf9, ink #202421, muted #646b65, line #e9ece7, accent #52634d, curtain #fafbf9.
Typography: self-hosted Host Grotesk variable (Google Fonts, OFL), 300 display / 400 body / 500 controls. Canvas uses the local monospace stack for ASCII.
Grid: 12 columns, 40px desktop / 22px mobile gutters. Background 8px graph grid. Headline centered with generous negative space, humans asymmetrically positioned at edges.
Shape: 6px button corners; pill for a small introductory link only.
Motion: single time driver from GSAP; 24fps ASCII render budget; pause when hidden/out of view; static reduced-motion scene; no smooth scroll or loader.
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
Phone: two edge figures, shorter line length, enlarged touch controls, one smaller foreground human. Figure detail stays legible.
Genericness check: removed feature-card grids, glowing gradients, fabricated stats and decorative terminal chrome. The reference-specific ASCII scene carries the entire hero.
Scope: hero only; native accessible dialog supplies a brief product explanation without inventing extra pages. No public domain deployment as part of this implementation; review the concrete hero first.
