# Screen2Figma

A Figma plugin that turns a screenshot of any UI (website, web app, mobile or
tablet app) into an **editable Figma design**: real text layers, auto-layout
frames where the layout allows it, solid/gradient fills, borders, radii,
shadows, and exact image crops for photos and icons.

It is a clean-room build (no third-party plugin code), powered by Claude vision
plus deterministic pixel measurement, so geometry and colours come from the
screenshot's pixels rather than from the model's estimates.

## How it works

```
screenshot ─┬─> Claude (structured output): element tree, text, styles, layout hints
            │      tall pages are sliced at blank rows; overflow auto-splits and retries
            ├─> detail pass (pixel-perfect): each section re-analysed at full resolution
            ├─> pixel snapping: edges measured on the image, text = tight ink box,
            │      line count, line pitch and per-line widths measured per paragraph
            ├─> colour measurement: fills and text ink sampled from the pixels
            ├─> Figma render: bottom-up; auto layout only when a plan reproduces the
            │      measured positions (≈1 screenshot px); text sized and positioned from
            │      Figma's own glyph render bounds; paragraphs wrap at the same words
            └─> verify loop (pixel-perfect): export → pixel diff → Claude corrects
                   missing/wrong elements → re-render, keep the best (up to N rounds)
```

| Folder | What lives there |
| --- | --- |
| `src/shared` | Pipeline, Claude calls, schema/prompts, snapping, layout inference, diff |
| `src/plugin` | Figma main thread: renderer, fonts, document I/O |
| `src/ui` | Plugin UI: input (upload / paste / drop / selected layer), image decoding, settings |
| `src/server` | Optional server that keeps the Anthropic key off designers' machines |
| `test` | Unit tests, pipeline tests, and the visual end-to-end suite |

## Install (local / team use)

```bash
cd tools/screenshot-to-figma
npm install
npm run build
```

In the **Figma desktop app**: *Plugins → Development → Import plugin from
manifest…* and pick `tools/screenshot-to-figma/manifest.json`. Run it from
*Plugins → Development → Screen2Figma*.

Open **Connection & model** in the plugin and either:

- paste an Anthropic API key (stored only in this Figma client), or
- point it at your Screen2Figma server (below).

## Using it

1. Drop, paste (⌘/Ctrl+V) or upload a screenshot, or select an image layer and
   click **Use selected layer**. PNG, JPEG, WebP, GIF, BMP, AVIF, ICO and SVG
   work; HEIC must be exported to PNG/JPEG first.
2. Choose **Quality**:
   - **Pixel-perfect** (default): detail pass + verify/correct loop. Slow.
   - **Fast**: one analysis pass, still pixel-snapped.
3. Pick the platform (or Auto) and the screenshot scale (Auto detects common
   Retina/phone scales; set 1.5x etc. manually for fractional scaling).
4. **Convert**. The design is placed next to your existing content, with the
   original screenshot beside it (optional) for comparison. The panel reports
   the measured visual match.

Fonts: the design uses the font the model identifies when it is installed in
Figma, otherwise the closest available (Inter by default). Install the brand's
fonts in Figma for the closest match; substitutions are listed after converting.

## Optional server

Keeps the API key on a server and lets you gate access with a shared token.

```bash
ANTHROPIC_API_KEY=sk-ant-... S2F_TOKEN=choose-a-secret PORT=8787 npm run server
```

Add your server's origin to `networkAccess.allowedDomains` in `manifest.json`
(localhost:8787 is already allowed for development), rebuild, and choose
*Screen2Figma server* in the plugin.

## Models and cost

Default model is Claude Opus 5.5 at high effort; Sonnet 5.5 and Haiku 5.5 can be
picked in settings. Pixel-perfect mode makes several calls per screenshot (one
per page slice, one per detected section, and one per mismatching region per
correction round), so it costs several times a fast conversion.

## Tests

```bash
npm test                  # unit + pipeline tests (vitest)
npm run e2e               # visual end-to-end suite (Chromium)
```

The e2e suite renders real UI fixtures with Chromium, builds a deliberately
**imprecise** model output from them (boxes off by ±2–6%, colours and font
sizes jittered), runs the pipeline, renders the result with the plugin's real
renderer inside a Figma Plugin API emulator (`test/e2e/emu`), and diffs it
against the original pixel by pixel ("bad cells" are 12×12 px blocks where most
pixels differ, i.e. real misplacements rather than anti-aliasing).

Latest results (match = share of pixels that agree within a 1 px / colour
tolerance):

| Fixture | Imprecise input, no snapping | Full pipeline | Bad cells | Ceiling (perfect input) |
| --- | --- | --- | --- | --- |
| Web landing page, 1x | 96.60% | **99.77%** | 0 | 99.56% |
| Mobile app, 3x | 96.84% | **99.43%** | 7 | 99.31% (16) |
| Dark dashboard with gradients, 2x | 98.58% | **99.76%** | 1 | 99.75% |
| Web landing page at 1.5x (Windows scaling) | 96.46% | **99.57%** | 0 | – |
| Landing page as JPEG (q80) | 96.60% | **99.77%** | 0 | – |
| Mobile app as JPEG (q60) | 96.84% | **99.20%** | 9 | – |

The "ceiling" row feeds the exact DOM geometry through the same renderer: the
remaining fraction of a percent is glyph rasterisation that differs between
the browser that took the screenshot and the renderer, not layout error.
100.0% is not reachable when the screenshot came from a different text
rasteriser than Figma's.

The emulator implements the subset of the Plugin API the renderer uses
(frames, auto layout, text layout with glyph bounds, fills, strokes, effects).
Final behaviour should still be checked in Figma itself.

## Limitations

- Icons are exact image crops by default; *Vector (AI redraw)* asks Claude for
  SVGs, which are editable but approximate.
- Text that is part of a photo or illustration stays in the image.
- Very dense screens take longer: overflowing analyses are split automatically.
- Screenshots must not exceed ~60 megapixels (larger ones are downscaled).
