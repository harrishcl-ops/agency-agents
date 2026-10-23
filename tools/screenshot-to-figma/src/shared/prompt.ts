import type { IconMode, Platform } from "./types";

export const SYSTEM_PROMPT = `You convert screenshots of user interfaces into a structured description that is rebuilt as an editable Figma design. A designer will keep working on the result, so it must look like a well-organised file a person would make, while matching the screenshot as closely as possible.

Coordinates
- All x, y, w, h values are absolute pixels in the image you are given (origin top-left), never relative to the parent.
- Boxes should hug the visible element: for text, the box around the rendered glyph lines; for containers, the visible background/border edges.

Structure
- Emit every visible element. Group them the way a designer would: page sections, cards, nav bars, list rows, buttons, inputs, chips. Use "frame" for any container (it can have fill, stroke, radius, shadow) and nest elements inside the frame that visually contains them.
- "parent" is the id of the containing frame, or "root". A parent must appear before its children in the list. Siblings are listed in reading order; later siblings are drawn on top.
- "layout" on a frame says how its direct children flow: "row" (side by side), "column" (stacked), or "none" (free/overlapping).
- Buttons, inputs, tabs, badges and chips are frames whose label is a child "text" node.
- "text": one node per paragraph or label (multi-line paragraphs stay one node, with \\n only where the screenshot has a hard break). Transcribe text exactly. Give fontSize in pixels, lineHeight in pixels when it is visibly larger than the font size (else null), fontWeight 100-900, and the closest common font family (e.g. Inter, Roboto, SF Pro Text, Poppins, Montserrat, Open Sans, Lato, Helvetica Neue, Georgia).
- "image": photos, illustrations, logos, avatars, maps, charts drawn as pictures. They are cropped from the screenshot, so the box must be tight. Use radius for rounded or circular images.
- "icon": small glyph icons (usually 12-48px).
- "rectangle" / "ellipse": plain shapes without children (dividers that are thicker than 1px, dots, progress bars). "line": 1px dividers (h or w = 1).

Styling
- fill: solid background hex (#RRGGBB, or #RRGGBBAA when translucent), null when transparent. Use gradient (with null fill) for gradient backgrounds.
- stroke/strokeWidth for visible borders, radius for corner radius, shadow for a visible drop shadow, opacity only when the whole element is faded.
- name: short human-readable layer names ("Primary button", "Pricing card", "Nav / Logo").
- svg: null unless asked for vector icons.
- ids are short unique strings.`;

export function buildUserPrompt(opts: {
  width: number;
  height: number;
  platform: Platform;
  iconMode: IconMode;
  part?: { index: number; count: number };
  /** Detail pass: the image is a crop of one section of a larger screen. */
  section?: { name: string; background: string | null };
}): string {
  const lines = [
    `The screenshot is ${opts.width}x${opts.height} pixels.`,
  ];
  if (opts.platform === "mobile") {
    lines.push("It is a mobile app screen (iOS or Android); prefer SF Pro Text / Roboto when the font is a system font.");
  } else if (opts.platform === "tablet") {
    lines.push("It is a tablet app screen.");
  } else if (opts.platform === "web") {
    lines.push("It is a website or web app.");
  }
  if (opts.part && opts.part.count > 1) {
    lines.push(
      `This image is part ${opts.part.index + 1} of ${opts.part.count} of one tall page, cut horizontally. Describe only what is in this part; elements cut at the top or bottom edge should be described as they appear.`,
    );
  }
  if (opts.section) {
    lines.push(
      `This image is a crop showing only the "${opts.section.name}" section of a larger screen${opts.section.background ? ` (its background is ${opts.section.background})` : ""}. Do not emit a node for the section itself: describe everything inside it, with top-level elements using parent "root".`,
    );
  }
  if (opts.iconMode === "vector") {
    lines.push(
      'For every "icon" node, also set "svg" to a compact, self-contained <svg> (viewBox matching the icon box size, stroke/fill in the icon colour) that redraws the glyph.',
    );
  }
  lines.push("Describe everything in the image.");
  return lines.join("\n");
}

export const CORRECTION_SYSTEM_PROMPT = `You review an automated conversion of a UI screenshot into Figma layers and correct it.

You get three images of the same region at the same scale:
1. the original screenshot,
2. the current Figma rendering,
3. a difference mask (grey = matches, red = pixels that differ).
You also get the JSON of the layers in that region, with coordinates in that region's pixel space (origin top-left of the images).

Fix what makes the rendering differ from the original:
- missing elements (add them), spurious elements (delete them),
- wrong text content, font size, weight, family, colour, alignment, line breaks,
- wrong fills, gradients, borders, radii, shadows,
- elements in the wrong place or with the wrong size.
Small red fringes around text are expected anti-aliasing and font-rendering differences; ignore them. Leave correct layers alone.

Return:
- "updates": full replacement objects for layers you change (same id, same parent unless re-parenting is needed),
- "additions": new layers (new unique ids; parent is an existing id or "root" for the region's top level),
- "deletions": ids to remove.
Return empty lists when the rendering already matches.`;

export function buildCorrectionPrompt(opts: {
  width: number;
  height: number;
  nodesJson: string;
  mismatchPercent: number;
  iconMode: IconMode;
}): string {
  return [
    `The region is ${opts.width}x${opts.height} pixels. ${opts.mismatchPercent.toFixed(1)}% of its pixels currently differ.`,
    opts.iconMode === "vector" ? 'Icons should carry an "svg" redraw.' : 'Keep "svg" null.',
    "Current layers in this region:",
    opts.nodesJson,
  ].join("\n");
}
