# Design QA

## Reference

- Source of truth: user-provided `Electron Appshot 2026-07-21T21-44-23.599Z.png` plus the instruction to replace the Forge title with Back, Forward, and Sidebar icon controls in the macOS title bar.
- State: Forge desktop app at `/inbox`, light appearance.
- Viewport: 1224 × 768 captured output (1800 × 1130 renderer viewport).

## Implementation evidence

- Full-window capture: `/var/folders/j2/gzj18t_x2251dx_cnqdcscm80000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-07-21 at 11.52.58 PM.jpeg`
- The macOS-only title bar is a 32 CSS-pixel draggable region, matching the original native title-bar footprint at the captured scale.
- The fixed sidebar container and main application wrapper now share the same 32 CSS-pixel desktop content origin.
- The title bar uses the application background and has no border, divider, or shadow.
- The web renderer is unchanged because the title-bar region is enabled only by the macOS Electron host.
- The title-bar controls use Hugeicons `ArrowLeft02Icon`, `ArrowRight02Icon`, and `SidebarLeftIcon` at the sidebar's 16 CSS-pixel icon size inside 24 CSS-pixel hit targets.
- Back and Forward were verified across `/inbox` and `/forge`; the relocated Sidebar button was verified collapsing and restoring the sidebar.

## Visual comparison

- Layout and spacing: passed — the sidebar and main surface now begin on the same horizontal axis beneath the traffic-light region.
- Typography and copy: passed — application typography and labels are unchanged.
- Colors: passed — the title bar now uses the app shell's `--sidebar` token, producing one continuous chrome color across the title bar and surrounding shell.
- Borders: passed — the native bottom separator is absent and no replacement border was introduced.
- Images and icons: passed — the new title-bar controls use the requested `02` arrow variants and match the sidebar's 16-pixel size and foreground color.
- Focused region, top-left chrome: passed — the text title is absent; the three larger icon controls sit after the traffic lights with clear spacing and no overlap.
- Copy and content: passed — the unwanted Forge title was removed, while every icon button has an accessible label and native tooltip.

## Iteration history

1. The native light title bar matched the app color but retained the macOS separator.
2. The first hidden-title-bar pass reserved only 22 CSS pixels, which was too short at this Retina window scale.
3. The final pass reserves 32 CSS pixels, matching the native footprint and clearing all application controls without adding a separator.
4. A later P2 alignment check found that the sidebar's fixed positioning still used `inset-y-0`, ignoring the document-flow title-bar offset while the main wrapper respected it.
5. The sidebar container now uses `top: 32px` and `height: calc(100svh - 32px)` on macOS. The post-fix capture shows both app surfaces sharing the same top origin.
6. A P2 color mismatch remained because the custom title bar used the pure page `--background` token while the app shell used the subtly tinted `--sidebar` token.
7. The title bar now uses `--sidebar`; the final capture shows a continuous full-width shell color with the white main surface inset beneath it.
8. A P2 desktop-control placement issue remained: the sidebar toggle lived in the page header and the title bar still displayed Forge text.
9. The Forge title and page-header toggle were removed. Functional Back, Forward, and Sidebar controls were placed in a non-draggable title-bar control group.
10. The initial arrow controls used the smaller `01` chevron variants. The final pass uses `ArrowLeft02Icon` and `ArrowRight02Icon`; all three controls match the sidebar's 16 CSS-pixel size and `--sidebar-foreground` color. Post-fix navigation and sidebar behavior passed.

## Final result

passed
