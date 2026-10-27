# Forge empty-state figures

A shared collection of decorative Figure-size objects, using the Anatomy kit's filled isometric
solids, four side tones, bevels, and face-mounted detail. The existing empty-state
title, copy, and actions frame each figure; the artwork adds no product controls.

## Projects — project filing cabinet

An open top drawer reveals indexed project folders. The drawer extends slightly
when the illustration is hovered or its create action receives keyboard focus.

Parts, before geometry: plinth; four foot pads; four foot blocks; cabinet floor;
rear wall; two side walls; two front stiles; lid; lid inset; six drawer runners;
three drawer floors; six drawer sides; three drawer rear walls; three drawer
fronts; six pull mounts; three pull bars; three label holders; three label cards;
four project folders; four folder tabs. Face screws and printed label rules
belong to those assemblies rather than adding floating texture.

## Views — light-table card selector

A sliding viewfinder frames a subset of indexed cards on a light table. Its
carriage moves one column along the guide rails on hover or create-action focus.

Parts, before geometry: plinth; four foot pads; four foot blocks; table body;
paper inset; two guide rails; four rail end stops; four viewfinder carriage feet;
four viewfinder frame bars; two handle mounts; handle bar; six indexed cards;
six card tabs; three slider beds; six slider guide strips; three slider thumbs;
three thumb inlays; front identification plate. Each frame, slider and card is
supported by the table or its rails. All geometry is prismatic; there are no
pipes, cables or turned bodies.

## Build and verification

Run `node apps/forge/scripts/illustrations/build-empty-state-art.mjs` with the
Anatomy skill installed at `~/.agents/skills/anatomy` (or set
`ANATOMY_SKILL_PATH`). Geometry is generated ahead of time; the app has no runtime
dependency on the skill. The generator also emits a standalone two-theme gallery
to this directory for close-up, mobile, motion and line-end checks.

## Extended empty-state set (2026-10-27)

The same materials, camera, and scale apply to every existing illustrated empty
state. Existing copy and actions remain the frame. These are decorative objects,
not new controls or a claim that a product integration is connected. Motion is a
short hover/focus response, with no idle loop, and respects reduced motion.

Concepts and parts planned before geometry:

- Inbox — a post-mounted mailbox. An envelope slides toward its open door.
  Foot pads, foundation, four foundation bolts, post socket, post, post seam,
  two mounting brackets, four bracket bolts, floor, two sides, rear panel,
  two sloped roof panels, roof ridge, roof seams, two door hinges, open door,
  door rim, latch, label holder, label, envelope, envelope flap, stamp,
  address lines, flag bracket, flag stalk, flag blade, flag pivot, four case
  fasteners, four door fasteners, two drainage slots.
- Signals — an orbital satellite with two solar arrays and a faceted antenna
  horn. One scan carriage moves over its instrument window. Two array frames,
  two array backs, twenty-four solar cells, four array hinges, two booms, bus
  shell, bus lid, four bus corner rails, two radiators, six radiator fins,
  instrument mount, instrument window, scan carriage, antenna pedestal,
  antenna throat, four horn walls, aperture rim, two alignment lugs.
- Reviews — a bench microscope. The specimen slide moves a few units on its
  mechanical stage. Base, four pads, four feet, plinth, lamp housing, lamp
  window, lamp rim, rear column, column inset, arm, head bracket, optical
  body, eyepiece stem, eyepiece housing, eyepiece rim, two focus housings,
  two focus inlays, six focus grip ribs, stage supports, stage, two stage
  rails, two end stops, slide carrier, glass slide, specimen inset, two slide
  clips, objective body, objective collar, objective aperture, four stage
  fasteners, four column fasteners, identification plate and printed rules.
- Issues — a tabletop ticket press. A ticket slides out of the delivery bed.
  Four pads, four feet, plinth, bed, bed inset, four guide strips, four guide
  stops, two uprights, two upright feet, two bearing blocks, crosshead,
  press carriage, press stem, die, die plate, ticket, ticket header, three
  checkbox frames, three checkbox inlays, three text-rule groups, delivery
  lip, lever support, lever arm, lever grip, two control keys, label plate,
  four head bolts, four bed bolts.
- Initiatives — a route-planning table with milestones joined by engraved
  channels. A route pointer slides to the next milestone. Four pads, four
  feet, plinth, table, inset map, four edge rails, eight rail fasteners,
  six milestone bases, six marker caps, five connecting channel inlays,
  pointer carriage, two carriage guides, pointer head, pointer inset,
  three planning cards, three tabs, six card rules, two control sliders,
  four slider guides, two slider thumbs, identification plate.
- Triage — a three-lane document sorting station. A selected ticket travels
  along its feed bed toward the gates. Four pads, four feet, plinth, feed
  bed, two edge guides, four end stops, three receiving floors, four lane
  dividers, three rear stops, three lane labels, three lane cards, three
  gate supports, three gate heads, six gate joints, control console,
  three keys, selected ticket, ticket header, ticket rules, feed tongue,
  four bed fasteners and identification plate.
- Upcoming cycles — a mechanical desk calendar. Its date cursor moves one
  cell along the weekly rail. Four pads, four feet, plinth, calendar bed,
  back support, calendar sheet, header strip, seven day headings, twenty-one
  date tiles, two binding supports, seven binding links, cursor guides,
  cursor frame (four bars), cursor handle, two end stops, identification
  plate and four base fasteners.
- Calls — a smartphone resting face-up, with a call waveform on its screen.
  The waveform brightens gently at rest and on hover/action focus; the phone
  stays assembled. The screen is decorative and does not indicate a live call.
  Parts planned before geometry: rear shell, aluminum frame, bezel, display
  glass, earpiece recess, eight earpiece mesh slots, camera surround, lens,
  lens reflection, two volume keys, power key, three key seats, four antenna
  breaks, USB-C recess, connector tongue, six lower speaker openings, two
  retaining screws, caller disc, caller inlay, two caller name rules, eleven
  waveform bars, three call-control discs, microphone and speaker glyphs,
  handset glyph, home indicator, and two status indicators. All face detail
  is attached to its host; the chassis has a continuous perimeter seam.

The initial additional bodies used flat-faced prismatic construction (including the square
optics and faceted antenna horn); there are no pipes, cables, shaders or turned
surfaces. Each overlapping assembly is painted back-to-front, with foreground
rims separated from the surfaces they contain.

## Reference-driven revisions and remaining illustrated settings

The supplied photos refine the object vocabulary: Reviews uses a binocular
microscope with round optics, a curved C-shaped support, a mechanical stage,
coarse/fine focus wheels and a substage lamp. Signals uses a cylindrical orbital
instrument with three segmented solar panels on each wing, foil bands, end
flanges, optical aperture and a small antenna. These two now use true turned
solids; every visible solid is recorded for the Anatomy geometry/depth audit.

Additional inventory: Documents gets a tabletop bookbinding press (feet, base,
two uprights, screw carriage, press plate, eight page leaves, cover boards, paper
stops, handle, spine labels and fasteners); Emojis gets a physical pixel-face
stamp tray (base, four feet, cartridge frame, twenty-five pixel dies, face tiles,
rails, handle, carriage and fasteners); initiative Labels gets a tag-printing
station (base, feed bed, guides, paper roll housing, die carriage, ticket stack,
six tag blanks, tag holes, label plates, control keys and fasteners). Each has
40+ supported prismatic parts and one small sliding assembly.


## Motion correction

The three reference-driven figures now share a visible-only motion controller:
Inbox's flag pivots in its physical side plane, Reviews adjusts its stage,
condenser and slide as one focus carriage while turning its dial, and Signals
moves the whole spacecraft with a gentle camera-axis attitude change. The latter
is a rigid image transform, so every internal depth relationship stays fixed.
Idle motion pauses offscreen; reduced motion remains still. Other figures retain
their existing hover/focus transitions.
