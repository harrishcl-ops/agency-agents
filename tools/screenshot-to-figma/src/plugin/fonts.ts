// Map the model's font guesses (family + numeric weight) onto fonts that are
// actually available in the user's Figma, falling back to Inter.

const WEIGHT_WORDS: [RegExp, number][] = [
  [/(hairline|thin)/, 100],
  [/(extra|ultra)light/, 200],
  [/light/, 300],
  [/(semi|demi)bold/, 600],
  [/(extra|ultra)bold/, 800],
  [/bold/, 700],
  [/(black|heavy)/, 900],
  [/medium/, 500],
];

export function styleWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, "");
  for (const [re, w] of WEIGHT_WORDS) if (re.test(s)) return w;
  return 400;
}

export const isItalicStyle = (style: string) => /italic|oblique/i.test(style);

/** Families to try for a requested family, most specific first. */
export function familyCandidates(family: string): string[] {
  const f = family.trim();
  const out = [f];
  const aliases: Record<string, string[]> = {
    "sf pro": ["SF Pro Text", "SF Pro Display", "SF Pro", "Inter"],
    "sf pro text": ["SF Pro", "SF Pro Display", "Inter"],
    "sf pro display": ["SF Pro", "SF Pro Text", "Inter"],
    "-apple-system": ["SF Pro Text", "SF Pro", "Inter"],
    "system-ui": ["SF Pro Text", "Roboto", "Inter"],
    "helvetica": ["Helvetica Neue", "Arial", "Inter"],
    "helvetica neue": ["Helvetica", "Arial", "Inter"],
    "segoe ui": ["Segoe UI Variable", "Inter"],
    "sans-serif": ["Inter"],
    "serif": ["Georgia", "Times New Roman", "Noto Serif"],
    "monospace": ["Roboto Mono", "JetBrains Mono", "Courier New"],
  };
  out.push(...(aliases[f.toLowerCase()] ?? []));
  out.push("Inter");
  return [...new Set(out)];
}

export interface AvailableFont {
  family: string;
  style: string;
}

export class FontResolver {
  private families = new Map<string, { family: string; styles: string[] }>();
  private loaded = new Map<string, Promise<void>>();
  readonly substituted = new Set<string>();

  constructor(available: AvailableFont[]) {
    for (const f of available) {
      const key = f.family.toLowerCase();
      const entry = this.families.get(key) ?? { family: f.family, styles: [] };
      entry.styles.push(f.style);
      this.families.set(key, entry);
    }
  }

  resolve(family: string, weight: number, italic: boolean): AvailableFont {
    for (const candidate of familyCandidates(family)) {
      const entry = this.families.get(candidate.toLowerCase());
      if (!entry || entry.styles.length === 0) continue;
      let best = entry.styles[0];
      let bestScore = Infinity;
      for (const style of entry.styles) {
        const score =
          Math.abs(styleWeight(style) - weight) + (isItalicStyle(style) === italic ? 0 : 1000);
        if (score < bestScore) {
          bestScore = score;
          best = style;
        }
      }
      if (candidate.toLowerCase() !== family.trim().toLowerCase()) this.substituted.add(family);
      return { family: entry.family, style: best };
    }
    this.substituted.add(family);
    return { family: "Inter", style: weight >= 600 ? "Bold" : "Regular" };
  }

  load(font: AvailableFont, loader: (f: AvailableFont) => Promise<void>): Promise<void> {
    const key = `${font.family}::${font.style}`;
    let p = this.loaded.get(key);
    if (!p) {
      p = loader(font);
      this.loaded.set(key, p);
    }
    return p;
  }
}
