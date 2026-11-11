# Forge website

A standalone marketing hero inspired by the supplied ASCII video. Procedural walking people replace the sharks: `src/figure.js` poses each body and gait, and `src/people.js` rasterises them into shaded ASCII tiles. No model, image, or video is fetched. Content remains semantic HTML; the decorative canvas uses a single GSAP clock, sleeps in background tabs, and renders a still scene for reduced motion. Fonts and branding are self-hosted. No app credentials or backend are required.

From the repository root:

```sh
bun install
bun run --cwd apps/website dev
bun run --cwd apps/website build
bun run --cwd apps/website preview
```

The website runs at http://127.0.0.1:4400. Deploy `apps/website/dist` as a static site after review. The app remains at https://app.forgenow.tech. `forgenow.tech` is the intended website domain; this change does not configure its DNS or hosting.
