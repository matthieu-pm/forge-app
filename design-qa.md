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
